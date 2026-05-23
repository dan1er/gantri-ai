import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { logger } from '../../logger.js';
import type { RollupRepo, RollupRow } from '../../storage/rollup-repo.js';

export interface GantriPorterConnectorDeps {
  baseUrl: string;
  email: string;
  password: string;
  /**
   * Optional. When provided, `gantri.order_stats` falls back to the daily
   * rollup table for date ranges that would otherwise overflow Porter's
   * paginate-and-aggregate cap (~2000 rows). Without it, large ranges silently
   * return a sample-of-2000 breakdown — see the comments in `orderStats` below.
   */
  rollupRepo?: RollupRepo;
  /** Optional — required only by the gantri.update_customer_email tool.
   *  When omitted, that tool fails with WRITE_DEPS_NOT_CONFIGURED. */
  writesRepo?: import('../../storage/repositories/gantri-writes.js').GantriWritesRepo;
  /** Optional — same. */
  usersRepo?: import('../../storage/repositories/authorized-users.js').AuthorizedUsersRepo;
  /** Optional — same. */
  getActor?: () => import('../../orchestrator/orchestrator.js').ActorContext | undefined;
  /** Optional — required when syncKlaviyo=true. */
  klaviyoClient?: import('../klaviyo/client.js').KlaviyoApiClient;
}

/**
 * Connector that talks to Gantri's Porter backend API as an admin user. The bot
 * authenticates via `POST /api/user/authenticate` and uses the returned HS256
 * JWT for subsequent calls. Tokens are cached in memory and refreshed on the
 * next 401 response.
 *
 * All tools here are READ ONLY — we never call PUT/POST/DELETE endpoints that
 * mutate data. Writes would require expanding this file deliberately.
 */
export class GantriPorterConnector implements Connector {
  readonly name = 'gantri';
  readonly tools: readonly ToolDef[];
  readonly rollupRepo: RollupRepo | undefined;

  private token: string | null = null;
  private tokenFetchedAt = 0;
  private inflight: Promise<string> | null = null;

  readonly deps: GantriPorterConnectorDeps;

  constructor(private readonly cfg: GantriPorterConnectorDeps) {
    this.deps = cfg;
    this.rollupRepo = cfg.rollupRepo;
    this.tools = buildPorterTools(this);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.getToken();
      return { ok: true, detail: `authenticated as ${this.cfg.email}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns a cached JWT, refreshing if >50 minutes old or missing. */
  async getToken(): Promise<string> {
    const FIFTY_MIN = 50 * 60 * 1000;
    if (this.token && Date.now() - this.tokenFetchedAt < FIFTY_MIN) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.login().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async login(): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/api/user/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
    });
    if (!res.ok) {
      throw new Error(`Porter authenticate failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    }
    const body = (await res.json()) as { success?: boolean; token?: string };
    if (!body.token) throw new Error('Porter authenticate returned no token');
    this.token = body.token;
    this.tokenFetchedAt = Date.now();
    logger.info('porter api token refreshed');
    return this.token;
  }

  /** HTTP request with auth + one-shot 401 retry (refreshes token once). */
  async fetchJson<T>(
    path: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.fetchJson<T>(path, init, 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Porter ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Per-request resolution of the write target. Read at request time (NOT
   *  cached) so a `fly secrets set PORTER_WRITE_TARGET=prod` flips behavior
   *  without redeploy. Default: staging. */
  writeBaseUrl(): string {
    return process.env.PORTER_WRITE_TARGET === 'prod'
      ? this.cfg.baseUrl
      : 'https://stage.api.gantri.com';
  }

  writeTargetLabel(): 'staging' | 'prod' {
    return process.env.PORTER_WRITE_TARGET === 'prod' ? 'prod' : 'staging';
  }

  /** Low-level HTTP helper that supports BOTH a base-URL override (for
   *  staging vs prod) AND a token override (for impersonation). Read paths
   *  use this for staging-aware GETs; the impersonation paths use it for
   *  the customer-token PUT. */
  async porterFetch<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    baseUrl?: string;
    token?: string;
  }): Promise<T> {
    const url = `${opts.baseUrl ?? this.cfg.baseUrl}${opts.path}`;
    const token = opts.token ?? (await this.getToken());
    const init: RequestInit = {
      method: opts.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    };
    if (opts.body !== undefined) {
      (init as any).body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
      const err = new Error(`Porter ${opts.method} ${opts.path} → HTTP ${res.status}`) as Error & { status?: number; body?: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return (await res.json()) as T;
  }

  async runUpdateCustomerEmail(rawArgs: {
    orderId?: number;
    oldEmail?: string;
    newEmail: string;
    syncKlaviyo?: boolean;
    confirm?: boolean;
  }): Promise<unknown> {
    // Defensive defaults: tests (and edge-case callers) may invoke execute()
    // with the schema's optional fields omitted, in which case the Zod defaults
    // wouldn't have applied. Mirror the schema defaults here.
    const args = {
      orderId: rawArgs.orderId,
      oldEmail: rawArgs.oldEmail,
      newEmail: rawArgs.newEmail,
      syncKlaviyo: rawArgs.syncKlaviyo ?? true,
      confirm: rawArgs.confirm ?? false,
    };
    const { writesRepo, usersRepo, getActor, klaviyoClient } = this.deps;
    if (!writesRepo || !usersRepo || !getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'gantri.update_customer_email requires writesRepo + usersRepo + getActor in connector deps.' } };
    }
    const actor = getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'gantri.update_customer_email requires an active actor.' } };
    const role = await usersRepo.getRole(actor.slackUserId);
    if (role !== 'cx' && role !== 'admin') {
      return { error: { code: 'FORBIDDEN', message: 'gantri.update_customer_email requires role=cx or role=admin.' } };
    }

    // Reject invalid arg combinations: exactly one of orderId / oldEmail.
    // Schema-level refine catches this on the orchestrator path; this guard
    // also covers direct connector callers (tests, smokes, future re-uses).
    if (!!args.orderId === !!args.oldEmail) {
      return {
        error: {
          code: 'INVALID_ARGS',
          message: 'Provide exactly one of orderId or oldEmail (not both, not neither).',
        },
      };
    }

    const baseUrl = this.writeBaseUrl();
    const target = this.writeTargetLabel();

    // 1. Resolve the customer. Both branches produce the same locals so the
    //    rest of the flow (preview / confirm / PUT / audit) is unchanged.
    let orderId: number;
    let userId: number | undefined;
    let currentEmail: string;
    let customerToken: string | undefined;
    let klaviyoId: string | null;
    let firstName: string;
    let lastName: string;
    // totalOrders may be carried over from the oldEmail resolver to skip a
    // redundant paginated-transactions call in the preview branch.
    let totalOrdersFromResolver: number | undefined;

    if (args.orderId) {
      // Existing path: fetch the order by id, extract the user fields.
      let orderResp: { order: any } | null = null;
      try {
        orderResp = await this.porterFetch<{ order: any }>({
          method: 'GET',
          path: `/api/admin/transactions/${args.orderId}`,
          baseUrl,
        });
      } catch (err: any) {
        if (err?.status === 404) {
          return { error: { code: 'ORDER_NOT_FOUND', message: `Order ${args.orderId} not found in ${target}.` } };
        }
        return { error: { code: 'PORTER_ERROR', status: err?.status, message: err?.message ?? String(err), body: err?.body } };
      }
      const order = orderResp.order;
      orderId = args.orderId;
      customerToken = order?.user?.authToken;
      userId = order?.user?.id;
      klaviyoId = order?.user?.klaviyoId ?? null;
      currentEmail = order?.email ?? '';
      // Names live on `order.user`, not at the top level. The order shape has
      // a `customerName` virtual field but no top-level `firstName/lastName`.
      // Prefer `order.user.*` and fall back to top-level only as a paranoid
      // last resort.
      firstName = order?.user?.firstName ?? order?.firstName ?? '';
      lastName = order?.user?.lastName ?? order?.lastName ?? '';
    } else {
      // New path: oldEmail → /api/admin/users/by-email returns the same
      // adminUserInfo shape as by-id, including `shop.orders` (every order
      // id this user has). Take the highest id (most recent), then fetch
      // /api/admin/transactions/<id> to obtain the populated user
      // (authToken / klaviyoId — both stripped from the shop.orders summary).
      // After the GET, the rest of the flow is identical to the orderId path.
      const userRes = await this.resolveUserByEmail(args.oldEmail!, baseUrl, target);
      if (!userRes.ok) return { error: userRes.error };

      let orderResp: { order: any };
      try {
        orderResp = await this.porterFetch<{ order: any }>({
          method: 'GET',
          path: `/api/admin/transactions/${userRes.mostRecentOrderId}`,
          baseUrl,
        });
      } catch (err: any) {
        if (err?.status === 404) {
          return {
            error: {
              code: 'ORDER_NOT_FOUND',
              message: `Order ${userRes.mostRecentOrderId} (most-recent for ${args.oldEmail}) not found in ${target}.`,
            },
          };
        }
        return { error: { code: 'PORTER_ERROR', status: err?.status, message: err?.message ?? String(err), body: err?.body } };
      }
      const order = orderResp.order;
      orderId = userRes.mostRecentOrderId;
      userId = userRes.userId;
      customerToken = order?.user?.authToken;
      klaviyoId = order?.user?.klaviyoId ?? userRes.klaviyoId ?? null;
      currentEmail = userRes.currentEmail;
      firstName = order?.user?.firstName ?? order?.firstName ?? userRes.firstName ?? '';
      lastName = order?.user?.lastName ?? order?.lastName ?? userRes.lastName ?? '';
      totalOrdersFromResolver = userRes.totalOrders;
    }

    // 2. Preview
    if (!args.confirm) {
      let totalOrders: number;
      if (totalOrdersFromResolver !== undefined) {
        // Already fetched while resolving the oldEmail path — reuse it.
        totalOrders = totalOrdersFromResolver;
      } else {
        totalOrders = 1;
        try {
          const tx = await this.porterFetch<{ allOrders?: number; orders?: unknown[] }>({
            method: 'POST',
            path: '/api/admin/paginated-transactions',
            baseUrl,
            body: { start: 0, count: 100, search: currentEmail },
          });
          totalOrders = tx.allOrders ?? tx.orders?.length ?? 1;
        } catch { /* fall back to 1 */ }
      }
      const willSyncKlaviyo = args.syncKlaviyo && !!klaviyoId;
      const customerName = (firstName || lastName) ? `${firstName} ${lastName}`.trim() : '(unnamed)';
      const targetPrefix = target === 'staging'
        ? '_(staging mode — change applies to stage.api.gantri.com only)_\n'
        : '_(PROD MODE — change applies to live customer data)_\n';
      const message = `${targetPrefix}About to change email on Porter user *${userId}* (${customerName}) from \`${currentEmail}\` to \`${args.newEmail}\`. This customer has *${totalOrders} order${totalOrders === 1 ? '' : 's'}* total — all of them will reflect the new email.${willSyncKlaviyo ? ` Klaviyo profile *${klaviyoId}* is linked and will also be updated.` : (klaviyoId ? ' Klaviyo sync was disabled by request.' : ' No Klaviyo profile linked.')}\nReply *yes* to confirm.`;
      return {
        kind: 'awaiting_confirmation' as const,
        target,
        orderId,
        userId,
        customerName,
        currentEmail,
        newEmail: args.newEmail,
        totalOrders,
        klaviyoProfileLinked: !!klaviyoId,
        willSyncKlaviyo,
        message,
      };
    }

    // 3. Execute
    if (!customerToken) {
      return { error: { code: 'NO_AUTH_TOKEN', message: `Order ${orderId} response did not include user.authToken — cannot impersonate.` } };
    }

    let porterOk = false;
    let klaviyoOk = false;
    let klaviyoError: string | undefined;
    try {
      // 3a. Fetch customer's current state via impersonation
      const me = await this.porterFetch<{ data?: { firstName?: string; lastName?: string }; firstName?: string; lastName?: string }>({
        method: 'GET',
        path: '/api/user',
        baseUrl,
        token: customerToken,
      });
      const meFirstName = me.data?.firstName ?? me.firstName ?? firstName ?? 'Customer';
      const meLastName = me.data?.lastName ?? me.lastName ?? lastName ?? '';

      // 3b. PUT new email
      await this.porterFetch({
        method: 'PUT',
        path: '/api/user',
        baseUrl,
        token: customerToken,
        body: { email: args.newEmail, firstName: meFirstName, lastName: meLastName },
      });
      porterOk = true;
      logger.info({ caller: actor.slackUserId, order_id: orderId, user_id: userId, target }, 'gantri_customer_email_porter_updated');

      // 3c. Klaviyo sync
      if (args.syncKlaviyo && klaviyoId && klaviyoClient) {
        try {
          await klaviyoClient.updateProfileEmail(klaviyoId, args.newEmail);
          klaviyoOk = true;
          logger.info({ caller: actor.slackUserId, order_id: orderId, klaviyo_id: klaviyoId }, 'gantri_customer_email_klaviyo_synced');
        } catch (err: any) {
          klaviyoError = err?.message ?? String(err);
          logger.warn({ caller: actor.slackUserId, order_id: orderId, error: klaviyoError }, 'gantri_customer_email_klaviyo_failed');
        }
      } else if (args.syncKlaviyo && !klaviyoId) {
        logger.info({ caller: actor.slackUserId, order_id: orderId, reason: 'no_klaviyo_id' }, 'gantri_customer_email_klaviyo_skipped');
      } else if (!args.syncKlaviyo) {
        logger.info({ caller: actor.slackUserId, order_id: orderId, reason: 'sync_disabled' }, 'gantri_customer_email_klaviyo_skipped');
      }

      // 3d. Audit
      const klaviyoNeeded = args.syncKlaviyo && !!klaviyoId;
      const status: 'success' | 'partial' = (klaviyoNeeded && !klaviyoOk) ? 'partial' : 'success';
      await writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'update_customer_email',
        porterUserId: userId ?? null,
        porterOrderId: orderId,
        klaviyoProfileId: (klaviyoNeeded && klaviyoOk) ? klaviyoId : null,
        requestPayload: { ...args, fromEmail: currentEmail },
        responsePayload: { porterOk, klaviyoOk, klaviyoError },
        status,
        writeTarget: target,
      });

      const targetPrefix = target === 'staging' ? '_(staging)_ ' : '_(PROD)_ ';
      const klaviyoMsg = klaviyoNeeded
        ? (klaviyoOk
            ? ' Klaviyo synced.'
            : ` Klaviyo sync FAILED: ${klaviyoError}. Re-run with syncKlaviyo:true to retry just that step.`)
        : '';
      return {
        ok: true as const,
        target,
        porterOk,
        klaviyoOk,
        klaviyoError,
        message: `${targetPrefix}Email updated. Porter user ${userId} → \`${args.newEmail}\`.${klaviyoMsg}`,
      };
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const body = err?.body;
      const message = err instanceof Error ? err.message : String(err);
      await writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'update_customer_email',
        porterUserId: userId ?? null,
        porterOrderId: orderId,
        klaviyoProfileId: null,
        requestPayload: { ...args, fromEmail: currentEmail },
        responsePayload: { error: { code: 'PORTER_ERROR', status, message, body }, porterOk, klaviyoOk },
        status: 'failure',
        writeTarget: target,
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, order_id: orderId, error_code: 'PORTER_ERROR', status }, 'gantri_customer_email_failed');
      return { error: { code: 'PORTER_ERROR', status, message, body } };
    }
  }

  /**
   * Merge two customer accounts. The "old" account's transactions are moved
   * to the "new" account by Porter's POST /api/admin/users/merge endpoint,
   * which also soft-deletes the old account (`active=false`/`deletedAt`) and
   * copies firstName/lastName to the new account ONLY if the new account's
   * profile is empty.
   *
   * Mirrors `runUpdateCustomerEmail`'s two-step confirm: confirm:false
   * returns a preview (resolves both users by-email, counts orders, checks
   * for klaviyo conflict); confirm:true POSTs to Porter and audits the
   * result.
   *
   * Klaviyo merge is OUT OF SCOPE for v1 — if both accounts have linked
   * Klaviyo profiles we surface a warning in the preview but never call
   * Klaviyo from here.
   */
  async runMergeCustomerAccounts(rawArgs: {
    oldEmail: string;
    newEmail: string;
    confirm?: boolean;
  }): Promise<unknown> {
    const args = {
      oldEmail: rawArgs.oldEmail,
      newEmail: rawArgs.newEmail,
      confirm: rawArgs.confirm ?? false,
    };
    const { writesRepo, usersRepo, getActor } = this.deps;
    if (!writesRepo || !usersRepo || !getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'gantri.merge_customer_accounts requires writesRepo + usersRepo + getActor in connector deps.' } };
    }
    const actor = getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'gantri.merge_customer_accounts requires an active actor.' } };
    const role = await usersRepo.getRole(actor.slackUserId);
    if (role !== 'cx' && role !== 'admin') {
      return { error: { code: 'FORBIDDEN', message: 'gantri.merge_customer_accounts requires role=cx or role=admin.' } };
    }

    const baseUrl = this.writeBaseUrl();
    const target = this.writeTargetLabel();

    // 1. Resolve both users via /api/admin/users/by-email. The merge endpoint
    // doesn't impersonate the customer (it's a direct admin write), so we
    // don't need an authToken — only userId + klaviyoId + profile fields.
    // Both accounts may have zero orders; that's a legitimate merge.
    const oldRes = await this.resolveUserByEmailNoOrders(args.oldEmail, baseUrl, target);
    if (!oldRes.ok) {
      if (oldRes.error.code === 'USER_NOT_FOUND_BY_EMAIL') {
        return { error: { code: 'OLD_USER_NOT_FOUND', message: `No user with email ${args.oldEmail} found in ${target}.` } };
      }
      return { error: oldRes.error };
    }

    const newRes = await this.resolveUserByEmailNoOrders(args.newEmail, baseUrl, target);
    if (!newRes.ok) {
      if (newRes.error.code === 'USER_NOT_FOUND_BY_EMAIL') {
        return { error: { code: 'NEW_USER_NOT_FOUND', message: `No user with email ${args.newEmail} found in ${target}.` } };
      }
      return { error: newRes.error };
    }

    if (oldRes.userId === newRes.userId) {
      return { error: { code: 'EMAILS_IDENTICAL', message: `Both emails resolve to the same Porter user (id ${oldRes.userId}). Nothing to merge.` } };
    }

    const oldUserId = oldRes.userId;
    const newUserId = newRes.userId;
    const oldFirstName = oldRes.firstName;
    const oldLastName = oldRes.lastName;
    const oldKlaviyoId = oldRes.klaviyoId;
    const newKlaviyoId = newRes.klaviyoId;
    const oldOrderCount = oldRes.totalOrders;

    // 2. Preview
    if (!args.confirm) {
      const customerName = (oldFirstName || oldLastName) ? `${oldFirstName} ${oldLastName}`.trim() : '(unnamed)';
      const targetPrefix = target === 'staging'
        ? '_(staging mode — change applies to stage.api.gantri.com only)_\n'
        : '_(PROD MODE — change applies to live customer data)_\n';
      const klaviyoConflict = !!oldKlaviyoId && !!newKlaviyoId;
      const klaviyoWarning = klaviyoConflict
        ? `\n⚠️ Both accounts have linked Klaviyo profiles (old=${oldKlaviyoId}, new=${newKlaviyoId}). Klaviyo merge is NOT done by this tool — manual reconciliation needed.`
        : '';
      const message = `${targetPrefix}About to merge \`${args.oldEmail}\` (${customerName}, *${oldOrderCount} order${oldOrderCount === 1 ? '' : 's'}* + any credits) INTO \`${args.newEmail}\`. Old account will be soft-deleted (\`active=false\`). Profile (firstName/lastName) copied to new account ONLY if new account's profile is empty.${klaviyoWarning}\nReply *yes* to confirm.`;
      return {
        kind: 'awaiting_confirmation' as const,
        target,
        oldUserId,
        newUserId,
        oldEmail: args.oldEmail,
        newEmail: args.newEmail,
        ordersToMove: oldOrderCount,
        klaviyoConflict,
        message,
      };
    }

    // 3. Execute — POST /api/admin/users/merge with the bot's admin token.
    let resp: any;
    try {
      resp = await this.porterFetch<any>({
        method: 'POST',
        path: '/api/admin/users/merge',
        baseUrl,
        body: { oldEmail: args.oldEmail, newEmail: args.newEmail },
      });
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const body = err?.body;
      // Map Porter typed error codes through unchanged when present in the
      // response body (NEW_ALREADY_SOFT_DELETED, OLD_ALREADY_SOFT_DELETED,
      // etc.). Fall back to PORTER_ERROR with the raw status otherwise.
      const code = (body && typeof body === 'object' && typeof (body as any).code === 'string')
        ? (body as any).code
        : 'PORTER_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      await writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'merge_customer_accounts',
        porterUserId: newUserId,
        porterOrderId: null,
        klaviyoProfileId: null,
        requestPayload: { ...args, oldUserId, newUserId },
        responsePayload: { error: { code, status, message, body } },
        status: 'failure',
        writeTarget: target,
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, old_user_id: oldUserId, new_user_id: newUserId, error_code: code, status }, 'gantri_merge_accounts_failed');
      return { error: { code, status, message, body } };
    }

    // Porter Phase 2 returns: { success, oldUserId, newUserId, ordersMoved,
    // creditsMoved, userCreditsBalanceMoved, giftCardCreditsBalanceMoved,
    // profileCopied, oldAccountSoftDeleted, klaviyoIds,
    // stocksMoved, addressesMoved, paymentsMoved, invitesMoved,
    // productReviewsMoved, npsReviewsMoved, giftsMoved, giftCardsMoved,
    // giftCodeTransactionsMoved, referralInvitesMoved, amazonCreditLogsMoved,
    // purchasesCounterMoved, referralsCounterMoved, referredUsersRepointed,
    // designerMoved, unmergedDueToConflict }.
    const ordersMoved: number = resp.ordersMoved ?? 0;
    const creditsMoved: number = resp.creditsMoved ?? 0;
    const userCreditsBalanceMoved: number = resp.userCreditsBalanceMoved ?? 0;
    const giftCardCreditsBalanceMoved: number = resp.giftCardCreditsBalanceMoved ?? 0;
    const stocksMoved: number = resp.stocksMoved ?? 0;
    const addressesMoved: number = resp.addressesMoved ?? 0;
    const paymentsMoved: number = resp.paymentsMoved ?? 0;
    const invitesMoved: number = resp.invitesMoved ?? 0;
    const productReviewsMoved: number = resp.productReviewsMoved ?? 0;
    const npsReviewsMoved: number = resp.npsReviewsMoved ?? 0;
    const giftsMoved: number = resp.giftsMoved ?? 0;
    const giftCardsMoved: number = resp.giftCardsMoved ?? 0;
    const giftCodeTransactionsMoved: number = resp.giftCodeTransactionsMoved ?? 0;
    const referralInvitesMoved: number = resp.referralInvitesMoved ?? 0;
    const amazonCreditLogsMoved: number = resp.amazonCreditLogsMoved ?? 0;
    const purchasesCounterMoved: number = resp.purchasesCounterMoved ?? 0;
    const referralsCounterMoved: number = resp.referralsCounterMoved ?? 0;
    const referredUsersRepointed: number = resp.referredUsersRepointed ?? 0;
    const designerMoved: boolean = resp.designerMoved === true;
    const unmergedDueToConflict: Array<{ table: string; oldId: number; newId: number }> =
      Array.isArray(resp.unmergedDueToConflict) ? resp.unmergedDueToConflict : [];

    await writesRepo.insert({
      callerSlackId: actor.slackUserId,
      action: 'merge_customer_accounts',
      porterUserId: newUserId,
      porterOrderId: null,
      klaviyoProfileId: null,
      requestPayload: { ...args, oldUserId, newUserId },
      responsePayload: resp,
      status: 'success',
      writeTarget: target,
    });
    logger.info(
      {
        caller: actor.slackUserId, old_user_id: oldUserId, new_user_id: newUserId, target,
        orders_moved: ordersMoved, stocks_moved: stocksMoved, addresses_moved: addressesMoved,
        purchases_counter_moved: purchasesCounterMoved, designer_moved: designerMoved,
        conflicts: unmergedDueToConflict.length,
      },
      'gantri_merge_accounts_succeeded',
    );

    // Build a breakdown line that only mentions tables that actually moved
    // rows. Skip zero-counts so the message stays readable when the merge
    // was for a light customer (typical case: orders + maybe an address).
    const movedParts: string[] = [];
    if (ordersMoved) movedParts.push(`*${ordersMoved} order${ordersMoved === 1 ? '' : 's'}*`);
    if (stocksMoved) movedParts.push(`*${stocksMoved} stock${stocksMoved === 1 ? '' : 's'}*`);
    if (addressesMoved) movedParts.push(`*${addressesMoved} address${addressesMoved === 1 ? '' : 'es'}*`);
    if (paymentsMoved) movedParts.push(`*${paymentsMoved} payment${paymentsMoved === 1 ? '' : 's'}*`);
    if (productReviewsMoved) movedParts.push(`*${productReviewsMoved} product review${productReviewsMoved === 1 ? '' : 's'}*`);
    if (npsReviewsMoved) movedParts.push(`*${npsReviewsMoved} NPS review${npsReviewsMoved === 1 ? '' : 's'}*`);
    if (giftsMoved) movedParts.push(`*${giftsMoved} gift${giftsMoved === 1 ? '' : 's'}*`);
    if (giftCardsMoved) movedParts.push(`*${giftCardsMoved} gift card${giftCardsMoved === 1 ? '' : 's'}*`);
    if (giftCodeTransactionsMoved) movedParts.push(`*${giftCodeTransactionsMoved} gift code txn${giftCodeTransactionsMoved === 1 ? '' : 's'}*`);
    if (invitesMoved) movedParts.push(`*${invitesMoved} invite${invitesMoved === 1 ? '' : 's'}*`);
    if (referralInvitesMoved) movedParts.push(`*${referralInvitesMoved} referral invite${referralInvitesMoved === 1 ? '' : 's'}*`);
    if (amazonCreditLogsMoved) movedParts.push(`*${amazonCreditLogsMoved} Amazon credit log${amazonCreditLogsMoved === 1 ? '' : 's'}*`);
    if (creditsMoved) movedParts.push(`*${creditsMoved} credit ledger row${creditsMoved === 1 ? '' : 's'}*`);

    const targetPrefix = target === 'staging' ? '_(staging)_ ' : '_(PROD)_ ';
    const creditsSummary = (userCreditsBalanceMoved || giftCardCreditsBalanceMoved)
      ? ` (cached balances: $${userCreditsBalanceMoved.toFixed(2)} user credits + $${giftCardCreditsBalanceMoved.toFixed(2)} gift card credits)`
      : '';

    // Cached counter line — only show when something moved.
    const counterParts: string[] = [];
    if (purchasesCounterMoved) counterParts.push(`+${purchasesCounterMoved} purchases counter`);
    if (referralsCounterMoved) counterParts.push(`+${referralsCounterMoved} referrals counter`);
    if (referredUsersRepointed) counterParts.push(`${referredUsersRepointed} downstream referral${referredUsersRepointed === 1 ? '' : 's'} re-pointed`);
    const countersLine = counterParts.length ? `\n• Reconciled: ${counterParts.join(', ')}.` : '';

    const designerLine = designerMoved ? `\n• Designer record moved to the surviving account.` : '';

    const conflictsLine = unmergedDueToConflict.length
      ? `\n• ⚠️ *Not collapsed (manual reconciliation needed)*: ${unmergedDueToConflict
          .map((c) => `${c.table} (old #${c.oldId} vs new #${c.newId})`)
          .join(', ')}.`
      : '';

    const movedSummary = movedParts.length
      ? `Moved ${movedParts.join(', ')}${creditsSummary} from \`${args.oldEmail}\` to \`${args.newEmail}\`.`
      : `No customer-side rows on \`${args.oldEmail}\` needed to be moved.`;

    const message = `${targetPrefix}Done. ${movedSummary}${countersLine}${designerLine}${conflictsLine}\nOld account is now inactive.`;

    return {
      ok: true as const,
      target,
      oldUserId,
      newUserId,
      ordersMoved,
      creditsMoved,
      userCreditsBalanceMoved,
      giftCardCreditsBalanceMoved,
      stocksMoved,
      addressesMoved,
      paymentsMoved,
      invitesMoved,
      productReviewsMoved,
      npsReviewsMoved,
      giftsMoved,
      giftCardsMoved,
      giftCodeTransactionsMoved,
      referralInvitesMoved,
      amazonCreditLogsMoved,
      purchasesCounterMoved,
      referralsCounterMoved,
      referredUsersRepointed,
      designerMoved,
      unmergedDueToConflict,
      profileCopied: resp.profileCopied ?? null,
      oldAccountSoftDeleted: resp.oldAccountSoftDeleted ?? true,
      klaviyoIds: resp.klaviyoIds ?? null,
      message,
    };
  }

  /**
   * Variant of resolveUserByEmail that doesn't require the user to have any
   * orders. Used by merge — both source and destination accounts may have
   * zero orders (the merge endpoint accepts that). Returns the same shape
   * minus mostRecentOrderId.
   */
  private async resolveUserByEmailNoOrders(
    email: string,
    baseUrl: string,
    target: 'staging' | 'prod',
  ): Promise<
    | { ok: true; userId: number; currentEmail: string; klaviyoId: string | null; firstName: string; lastName: string; totalOrders: number }
    | { ok: false; error: { code: string; message: string; status?: number; body?: unknown } }
  > {
    let resp: { account?: any; shop?: { orders?: any[] } };
    try {
      resp = await this.porterFetch<{ account?: any; shop?: { orders?: any[] } }>({
        method: 'GET',
        path: `/api/admin/users/by-email?email=${encodeURIComponent(email)}`,
        baseUrl,
      });
    } catch (err: any) {
      if (err?.status === 404) {
        return { ok: false, error: { code: 'USER_NOT_FOUND_BY_EMAIL', message: `No user with email ${email} found in ${target}.` } };
      }
      return { ok: false, error: { code: 'PORTER_ERROR', status: err?.status, message: err?.message ?? String(err), body: err?.body } };
    }
    const account = resp?.account ?? {};
    const userId = account.userId;
    if (typeof userId !== 'number') {
      return { ok: false, error: { code: 'PORTER_ERROR', message: `Unexpected /api/admin/users/by-email response: missing account.userId. Body keys: ${Object.keys(resp || {}).join(',')}` } };
    }
    return {
      ok: true,
      userId,
      currentEmail: account.email ?? email.toLowerCase().trim(),
      klaviyoId: account.klaviyoId ?? null,
      firstName: account.firstName ?? '',
      lastName: account.lastName ?? '',
      totalOrders: (resp?.shop?.orders ?? []).length,
    };
  }

  /**
   * Resolve a customer by their CURRENT email via /api/admin/users/by-email
   * (Porter PR #5114/#5115). The endpoint returns the same `adminUserInfo`
   * shape the by-id route returns — `{ account, activity, credits, referrals,
   * shop }` — so `shop.orders` already lists every order id this user has.
   * We use that directly to find the most-recent order id (no need to call
   * paginated-transactions, which has a fuzzy `search` tokenizer that breaks
   * on `@` anyway).
   *
   * Returns the user's id + the most-recent order id + profile fields, or a
   * typed error if the user isn't found / has no orders / Porter errors.
   *
   * The caller then issues a single `GET /api/admin/transactions/<id>` to
   * obtain the populated user (authToken / klaviyoId — both stripped from
   * the `shop.orders` summary entries). This unifies the two dispatch
   * branches: in both cases the caller ends up with the same populated
   * order response.
   */
  private async resolveUserByEmail(
    oldEmail: string,
    baseUrl: string,
    target: 'staging' | 'prod',
  ): Promise<
    | {
        ok: true;
        userId: number;
        currentEmail: string;
        klaviyoId: string | null;
        firstName: string;
        lastName: string;
        mostRecentOrderId: number;
        totalOrders: number;
      }
    | { ok: false; error: { code: string; message: string; status?: number; body?: unknown } }
  > {
    let resp: { account?: any; shop?: { orders?: any[] } };
    try {
      resp = await this.porterFetch<{ account?: any; shop?: { orders?: any[] } }>({
        method: 'GET',
        path: `/api/admin/users/by-email?email=${encodeURIComponent(oldEmail)}`,
        baseUrl,
      });
    } catch (err: any) {
      if (err?.status === 404) {
        return {
          ok: false,
          error: {
            code: 'USER_NOT_FOUND_BY_EMAIL',
            message: `No user with email ${oldEmail} found in ${target}.`,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'PORTER_ERROR',
          status: err?.status,
          message: err?.message ?? String(err),
          body: err?.body,
        },
      };
    }
    const account = resp?.account ?? {};
    const userId = account.userId;
    if (typeof userId !== 'number') {
      return {
        ok: false,
        error: {
          code: 'PORTER_ERROR',
          message: `Unexpected /api/admin/users/by-email response: missing account.userId. Body keys: ${Object.keys(resp || {}).join(',')}`,
        },
      };
    }
    const shopOrders = resp?.shop?.orders ?? [];
    // Sort by id desc — id is monotonic in Porter so the highest id is the
    // most recent order. Type filter is intentionally absent: any order
    // (Order, Repair, Replacement, etc.) carries the user's authToken since
    // the token is per-user not per-transaction.
    const sortedOrders = [...shopOrders].sort(
      (a, b) => (b?.id ?? 0) - (a?.id ?? 0),
    );
    const top = sortedOrders[0];
    if (!top || typeof top.id !== 'number') {
      return {
        ok: false,
        error: {
          code: 'USER_HAS_NO_ORDERS',
          message: `User ${oldEmail} (id ${userId}) has no orders in ${target}; cannot impersonate to update email. Add a Tier-2 admin endpoint that updates email without impersonation.`,
        },
      };
    }
    return {
      ok: true,
      userId,
      currentEmail: account.email ?? oldEmail.toLowerCase().trim(),
      klaviyoId: account.klaviyoId ?? null,
      firstName: account.firstName ?? '',
      lastName: account.lastName ?? '',
      mostRecentOrderId: top.id,
      totalOrders: shopOrders.length,
    };
  }
}

// ============================================================================

const TRANSACTION_TYPES = [
  'Order', 'Refund', 'Marketing', 'Replacement', 'Wholesale', 'Third Party',
  'R&D', 'Trade', 'Wholesale Refund', 'Third Party Refund', 'Trade Refund',
  'Made', 'Designer',
] as const;

const ORDER_STATUSES = [
  'Processed', 'Ready to ship', 'Partially shipped', 'Shipped',
  'Partially delivered', 'Delivered', 'Cancelled', 'Refunded',
  'Partially refunded', 'Lost',
] as const;

/** Convert a YYYY-MM-DD date (Pacific Time) to MM/DD/YYYY — the format Porter's
 *  controllers expect for startDate/endDate body params. They internally convert
 *  to PT unix-ms via moment + convertToPacificTZ. */
function toPorterDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${m}/${d}/${y}`;
}

const OrdersQueryArgs = z.object({
  types: z.array(z.enum(TRANSACTION_TYPES)).optional(),
  statuses: z.array(z.enum(ORDER_STATUSES)).optional(),
  search: z.string().min(1).max(200).optional()
    .describe('Free-text search matched against order id, customer name, email, etc.'),
  dateRange: DateRangeArg.optional(),
  late: z.boolean().optional(),
  hasPreOrderItemsAtCreation: z.boolean().optional()
    .describe('Filter for orders that contained at least one pre-order item at the moment of checkout (Transactions.hasPreOrderItemsAtCreation = true). Pass `true` to return ONLY pre-order orders, `false` to exclude them. Omit to return both. The flag is set at order-creation time and never recomputed, so it answers "which orders were pre-orders when placed?", not "which orders currently contain unfulfilled pre-order items".'),
  sortingField: z.enum(['id', 'createdAt', 'completedAt', 'amount']).default('id'),
  sortingType: z.enum(['ASC', 'DESC']).default('DESC'),
  page: z.number().int().min(1).default(1),
  count: z.number().int().min(1).max(200).default(25),
});
type OrdersQueryArgs = z.infer<typeof OrdersQueryArgs>;

const OrderGetArgs = z.object({
  id: z.number().int().positive(),
});
type OrderGetArgs = z.infer<typeof OrderGetArgs>;

const OrderStatsArgs = z.object({
  dateRange: DateRangeArg,
  types: z.array(z.enum(TRANSACTION_TYPES)).optional()
    .describe('Transaction types to include. Omit to include all types (useful for wholesale-customer aggregates that span Wholesale + Third Party + refunds).'),
  search: z.string().min(1).max(200).optional()
    .describe('Free-text search (customer name, email, order id). Applies to the same field as gantri.orders_query.'),
});
type OrderStatsArgs = z.infer<typeof OrderStatsArgs>;

// ============================================================================

function buildPorterTools(conn: GantriPorterConnector): ToolDef[] {
  /** Normalize an order row: extract dollar amounts, unwrap nested fields.
   *  Handles both response shapes — the paginated list nests user info under
   *  `user.{id,email,firstName,lastName}` and drops `customerName`, while the
   *  detail endpoint has a top-level `customerName`/`userId` plus a richer
   *  `user` object. We surface `email` either way so the caller can filter
   *  by exact email (Porter's `search` param is a substring match, not an
   *  email filter, so the email field is the only way to disambiguate). */
  function normalizeOrder(o: any) {
    const amt = o.amount ?? {};
    const user = o.user ?? {};
    const email = user.email ?? o.email ?? null;
    const customerName =
      o.customerName ??
      ([user.firstName, user.lastName].filter(Boolean).join(' ') || null);
    const userId = o.userId ?? user.id ?? null;
    const totalCents = computeTotalCents(amt);
    return {
      id: o.id,
      type: o.type,
      status: o.status,
      customerName,
      email,
      userId,
      organizationId: o.organizationId,
      shopifyOrderId: o.shopifyOrderId ?? null,
      productIds: o.productIds ?? [],
      createdAt: o.createdAt,
      shipsAt: o.shipsAt ?? null,
      completedAt: o.completedAt ?? null,
      shipmentStatus: o.shipmentStatus ?? null,
      shippingTrackingNumber: o.shippingTrackingNumber ?? null,
      shippingProvider: o.shippingProvider ?? null,
      totalDollars: totalCents === null ? null : round2(totalCents / 100),
      subtotalDollars: typeof amt.subtotal === 'number' ? round2(amt.subtotal / 100) : null,
      shippingDollars: typeof amt.shipping === 'number' ? round2(amt.shipping / 100) : null,
      taxDollars: typeof amt.tax === 'number' ? round2(amt.tax / 100) : null,
      transactionFeeDollars: typeof amt.transactionFee === 'number' ? round2(amt.transactionFee / 100) : null,
      address: o.address ?? null,
      tradeOrderId: o.tradeOrderId ?? null,
      tradePartnerId: o.tradePartnerId ?? null,
      notes: o.notes ?? null,
      adminLink: `http://admin.gantri.com/orders/${o.id}`,
    };
  }

  const ordersQuery: ToolDef<OrdersQueryArgs> = {
    name: 'gantri.orders_query',
    description:
      'Query orders from Gantri\'s own Porter system (source of truth, authenticated admin API). Supports filtering by transaction type(s), status(es), date range (Pacific Time), free-text search (order id / customer name / email), a "late" flag, and `hasPreOrderItemsAtCreation` (pass true for pre-order orders only, false to exclude them, omit for both). Returns paginated order records with normalized dollar amounts. This is the internal system of record; Northbeam tools are for attribution. Every order in the response has an `adminLink` pointing at admin.gantri.com.',
    schema: OrdersQueryArgs as z.ZodType<OrdersQueryArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
        statuses: { type: 'array', items: { type: 'string', enum: ORDER_STATUSES as unknown as string[] } },
        search: { type: 'string' },
        dateRange: {
          // Union: preset string | {start,end} | {startDate,endDate}.
          anyOf: [
            { type: 'string', description: 'PT preset (e.g. "last_30_days").' },
            { type: 'object', required: ['startDate', 'endDate'], properties: { startDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time.' }, endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive, Pacific Time.' } } },
            { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } },
          ],
        },
        late: { type: 'boolean' },
        hasPreOrderItemsAtCreation: { type: 'boolean', description: 'Filter for orders that contained pre-order items at creation. true = pre-order orders only, false = exclude pre-orders, omit = both.' },
        sortingField: { type: 'string', enum: ['id', 'createdAt', 'completedAt', 'amount'] },
        sortingType: { type: 'string', enum: ['ASC', 'DESC'] },
        page: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    async execute(args) {
      const body: Record<string, unknown> = {
        page: args.page,
        count: args.count,
        sortingField: args.sortingField,
        sortingType: args.sortingType,
      };
      if (args.types?.length) body.types = args.types;
      if (args.statuses?.length) body.statuses = args.statuses;
      if (args.search) body.search = args.search;
      if (args.late) body.late = true;
      if (typeof args.hasPreOrderItemsAtCreation === 'boolean') {
        body.hasPreOrderItemsAtCreation = args.hasPreOrderItemsAtCreation;
      }
      if (args.dateRange) {
        const range = normalizeDateRange(args.dateRange);
        body.startDate = toPorterDate(range.startDate);
        body.endDate = toPorterDate(range.endDate);
      }
      const data = await conn.fetchJson<{
        orders: unknown[];
        allOrders: number;
        maxPages: number;
        page: number;
      }>('/api/admin/paginated-transactions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        totalMatching: data.allOrders,
        maxPages: data.maxPages,
        page: data.page,
        returnedCount: data.orders.length,
        orders: data.orders.map(normalizeOrder),
      };
    },
  };

  const orderGet: ToolDef<OrderGetArgs> = {
    name: 'gantri.order_get',
    description:
      'Fetch a single Gantri order by its numeric ID from the Porter admin API. Returns the full record with customer info, amount breakdown, tracking, address, stocks, and notes.',
    schema: OrderGetArgs as z.ZodType<OrderGetArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', minimum: 1 },
      },
    },
    async execute(args) {
      const data = await conn.fetchJson<{ order: any }>(
        `/api/admin/transactions/${args.id}`,
        { method: 'GET' },
      );
      if (!data.order) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `Order ${args.id} not found` } };
      }
      const o = data.order;
      // Slim the response: the raw payload includes every job's full metadata
      // (machine state, gcode, instructions, etc.) which can balloon to 100k+
      // tokens for a multi-part order. Surface only the fields useful for
      // human-facing analysis (status, lateness, blockers, notes).
      // A single order can carry thousands of jobs (1 stock = many parts × many
      // QC/print/sand attempts). Returning them all blows the model context
      // (we've seen 1.6k jobs / 2.3M tokens). Strategy:
      //  - Aggregate stats per stock (counts by status, lateness, attention)
      //  - Surface only "interesting" jobs flagged by the workflow
      //    (attention / rework / late / exceeding cycle time / has comment)
      //  - Cap the interesting set at 30 per order, sorted most-recent-first
      const isInteresting = (j: any) =>
        j.hasAttention || j.isRework || j.isLateOrder ||
        (j.reasonsForExceeding && Object.keys(j.reasonsForExceeding).length > 0) ||
        (typeof j.exceededCycleTime === 'number' && j.exceededCycleTime > 0) ||
        (j.comment && String(j.comment).trim().length > 0) ||
        (j.cause && String(j.cause).trim().length > 0) ||
        (j.failedReason && Object.keys(j.failedReason).length > 0 && j.status !== 'Completed');
      const slimJob = (j: any, stockId: number) => ({
        stockId,
        id: j.id,
        description: j.description ?? null,
        status: j.status ?? null,
        attempt: j.attempt ?? null,
        isRework: j.isRework ?? false,
        isLateOrder: j.isLateOrder ?? false,
        hasAttention: j.hasAttention ?? false,
        highPriority: j.highPriority ?? false,
        machineName: j.machineName ?? null,
        machineType: j.machineType ?? null,
        assignedTo: j.assignedTo ?? null,
        startDate: j.startDate ?? null,
        endDate: j.endDate ?? null,
        completedAt: j.failedReason?.completedAt ?? j.completedAt ?? null,
        notes: j.notes ?? null,
        comment: j.comment ?? null,
        cause: j.cause ?? null,
        reasonsForExceeding: j.reasonsForExceeding && Object.keys(j.reasonsForExceeding).length ? j.reasonsForExceeding : null,
        exceededCycleTime: j.exceededCycleTime ?? null,
      });
      const allInteresting: any[] = [];
      let totalJobs = 0, interestingTotal = 0;
      const stocksSummary = Array.isArray(o.stocks)
        ? o.stocks.map((s: any) => {
            const jobs = Array.isArray(s.jobs) ? s.jobs : [];
            totalJobs += jobs.length;
            const byStatus: Record<string, number> = {};
            let attention = 0, rework = 0, late = 0, exceeded = 0;
            for (const j of jobs) {
              const st = j.status ?? 'Unknown';
              byStatus[st] = (byStatus[st] ?? 0) + 1;
              if (j.hasAttention) attention++;
              if (j.isRework) rework++;
              if (j.isLateOrder) late++;
              if (typeof j.exceededCycleTime === 'number' && j.exceededCycleTime > 0) exceeded++;
              if (isInteresting(j)) {
                interestingTotal++;
                allInteresting.push(slimJob(j, s.id));
              }
            }
            return {
              id: s.id,
              sku: s.sku ?? null,
              color: s.color ?? null,
              size: s.size ?? null,
              productId: s.productId ?? null,
              status: s.status ?? null,
              isLateOrder: s.isLateOrder ?? null,
              completedJobPercent: s.completedJobPercent ?? null,
              jobCount: jobs.length,
              jobsByStatus: byStatus,
              attentionCount: attention,
              reworkCount: rework,
              lateJobCount: late,
              exceededCount: exceeded,
            };
          })
        : [];
      // Sort interesting jobs by endDate (most recent first), cap at 30.
      allInteresting.sort((a, b) => String(b.endDate ?? '').localeCompare(String(a.endDate ?? '')));
      const interestingJobs = allInteresting.slice(0, 30);
      const shipmentsSummary = Array.isArray(o.shipments)
        ? o.shipments.map((sh: any) => ({
            id: sh.id,
            status: sh.status ?? null,
            shipsAt: sh.shipsAt ?? null,
            shippingTrackingNumber: sh.shippingTrackingNumber ?? null,
            shippingProvider: sh.shippingProvider ?? null,
            stocks: Array.isArray(sh.stocks)
              ? sh.stocks.map((st: any) => ({ sku: st.sku, stockName: st.stockName }))
              : [],
          }))
        : [];
      return {
        order: {
          ...normalizeOrder(o),
          additionalEmails: o.additionalEmails ?? null,
          billingAddress: o.billingAddress ?? null,
          payment: o.payment
            ? { type: o.payment.type ?? null, number: o.payment.number ?? null, nameOnCard: o.payment.nameOnCard ?? null }
            : null,
          stocks: stocksSummary,
          shipments: shipmentsSummary,
          jobsTotal: totalJobs,
          jobsInterestingTotal: interestingTotal,
          interestingJobs,
        },
      };
    },
  };

  const orderStats: ToolDef<OrderStatsArgs> = {
    name: 'gantri.order_stats',
    description:
      'Aggregate order stats for a date range (Pacific Time): total count, total revenue in dollars, average order value, and breakdown by status and type. For ranges that fit under ~2000 transactions, paginates Porter directly. For larger ranges (e.g. multi-month / multi-year queries) without a `search` filter, automatically uses the pre-aggregated daily rollup so totals match Grafana exactly. Per-customer or text-search queries always go through Porter.',
    schema: OrderStatsArgs as z.ZodType<OrderStatsArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dateRange'],
      properties: {
        dateRange: {
          // Union: preset string | {start,end} | {startDate,endDate}.
          anyOf: [
            { type: 'string' },
            { type: 'object', required: ['startDate', 'endDate'], properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } },
            { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } },
          ],
        },
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
        search: { type: 'string', description: 'Free-text search (customer name, email, order id).' },
      },
    },
    async execute(args) {
      const period = normalizeDateRange(args.dateRange);
      const startDateStr = toPorterDate(period.startDate);
      const endDateStr = toPorterDate(period.endDate);

      // Probe page 1 once to learn the true total. If it fits under the
      // pagination cap we paginate Porter for full per-row breakdowns. If not,
      // fall back to the daily rollup (which has correct totals + per-type and
      // per-status breakdowns pre-aggregated, matching Grafana).
      const pageSize = 200;
      const maxPages = 10; // 2000 rows cap before rollup fallback

      const firstPage = await conn.fetchJson<{
        orders: any[];
        allOrders: number;
        maxPages: number;
      }>('/api/admin/paginated-transactions', {
        method: 'POST',
        body: JSON.stringify({
          page: 1,
          count: pageSize,
          ...(args.types?.length ? { types: args.types } : {}),
          ...(args.search ? { search: args.search } : {}),
          startDate: startDateStr,
          endDate: endDateStr,
        }),
      });
      const totalCount = firstPage.allOrders;

      // Note: the rollup fallback for wide ranges has been removed. For revenue
      // / subtotal / shipping aggregates over wide ranges, use
      // `gantri.sales_report` (which runs Grafana's Sales-panel SQL live).
      // order_stats stays Porter-paginated and surfaces `breakdownIncomplete`
      // when the cap is hit so the LLM can warn the user.

      // Pagination path — works for ranges under the cap, or whenever a search
      // filter is applied.
      const statusCounts: Record<string, { count: number; revenueDollars: number }> = {};
      const typeCounts: Record<string, { count: number; revenueDollars: number }> = {};
      let totalRevenueCents = 0;
      let truncated = false;

      const consume = (orders: any[]) => {
        for (const o of orders) {
          const total = computeTotalCents(o.amount ?? {}) ?? 0;
          totalRevenueCents += total;
          const sKey = o.status ?? 'unknown';
          statusCounts[sKey] ??= { count: 0, revenueDollars: 0 };
          statusCounts[sKey].count++;
          statusCounts[sKey].revenueDollars += total / 100;
          const tKey = o.type ?? 'unknown';
          typeCounts[tKey] ??= { count: 0, revenueDollars: 0 };
          typeCounts[tKey].count++;
          typeCounts[tKey].revenueDollars += total / 100;
        }
      };
      consume(firstPage.orders);
      let lastPageSize = firstPage.orders.length;

      for (let page = 2; page <= maxPages && lastPageSize === pageSize; page++) {
        const data = await conn.fetchJson<{ orders: any[]; allOrders: number; maxPages: number }>(
          '/api/admin/paginated-transactions',
          {
            method: 'POST',
            body: JSON.stringify({
              page,
              count: pageSize,
              ...(args.types?.length ? { types: args.types } : {}),
              ...(args.search ? { search: args.search } : {}),
              startDate: startDateStr,
              endDate: endDateStr,
            }),
          },
        );
        consume(data.orders);
        lastPageSize = data.orders.length;
        if (page === maxPages && data.maxPages > maxPages) truncated = true;
      }

      // If we still fell short of `totalCount` (search filter present, no rollup
      // available, or other reason), flag the truncation so the LLM doesn't
      // surface a sample as if it were the full breakdown.
      const breakdownCount = Object.values(typeCounts).reduce((s, v) => s + v.count, 0);
      const breakdownIncomplete = breakdownCount < totalCount;

      const totalRevenueDollars = round2(totalRevenueCents / 100);
      return {
        period,
        typesFilter: args.types,
        source: 'porter' as const,
        totalOrders: totalCount,
        totalRevenueDollars: breakdownIncomplete ? null : totalRevenueDollars,
        avgOrderValueDollars: breakdownIncomplete || totalCount === 0
          ? null
          : round2(totalRevenueDollars / totalCount),
        statusBreakdown: Object.entries(statusCounts)
          .map(([status, v]) => ({ status, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        typeBreakdown: Object.entries(typeCounts)
          .map(([type, v]) => ({ type, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        truncated: truncated || breakdownIncomplete,
        breakdownIncomplete,
        ...(breakdownIncomplete
          ? {
              warning: `Porter pagination cap reached (${pageSize * maxPages} rows fetched of ${totalCount} matching). The breakdowns above reflect a SAMPLE, not the full range. Re-run without 'search' to use the rollup, or narrow the date range.`,
            }
          : {}),
      };
    },
  };

  const UpdateCustomerEmailArgs = z
    .object({
      orderId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Porter order id (the integer in https://admin.gantri.com/orders/<id>). Provide either orderId OR oldEmail, not both.',
        ),
      oldEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "The customer's CURRENT email on Porter. Use this when CX has the customer's email but no order id. Provide either orderId OR oldEmail, not both.",
        ),
      newEmail: z.string().email().describe('The new email to set on the customer.'),
      syncKlaviyo: z
        .boolean()
        .default(true)
        .describe(
          'When true (default), also patch the linked Klaviyo profile. Pass false to update Porter only.',
        ),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          'Pass true ONLY after the user has explicitly confirmed (e.g. replied "yes"). On the first call (confirm=false) the tool returns a preview asking for confirmation; do NOT auto-confirm.',
        ),
    })
    .refine((v) => !!v.orderId !== !!v.oldEmail, {
      message: 'Provide exactly one of orderId or oldEmail (not both, not neither).',
    });
  type UpdateCustomerEmailArgs = z.infer<typeof UpdateCustomerEmailArgs>;
  const updateCustomerEmailTool: ToolDef<UpdateCustomerEmailArgs> = {
    name: 'gantri.update_customer_email',
    description: [
      'Change the email on a Gantri customer account. Goes through Porter\'s PUT /api/user via impersonation, so all app-level hooks fire (uniqueness validation, notification email to the old address, session-token invalidation). Optionally syncs the change to the linked Klaviyo profile in the same call.',
      'Two ways to identify the customer: pass `orderId` (when CX has an order URL) OR `oldEmail` (when CX has only the customer email). Provide exactly one. The oldEmail path resolves to userId via /api/admin/users/by-email and then fetches the most recent order to obtain the auth token used for impersonation.',
      'CX or ADMIN role only — fails with FORBIDDEN otherwise.',
      'TWO-STEP CONFIRM: first call without confirm:true returns a preview (current email, customer name, total order count, klaviyo-linked flag); relay the preview to the user, wait for explicit "yes"/"si" in the NEXT message, then re-call with confirm:true. NEVER auto-confirm.',
      'Use when CX says: "modify email on order X to Y", "cambia el correo en el order X", "update customer email on order X", or relays a CX ticket text. Also: "modify email on alice@x.com to bob@y.com", "cambia el correo de alice@x.com", "update customer email for alice@x.com" — these are the oldEmail-mode triggers.',
      'When PORTER_WRITE_TARGET=staging (default), writes hit stage.api.gantri.com. When set to prod, writes hit production. Surface the target prominently in the user-facing reply.',
    ].join(' '),
    schema: UpdateCustomerEmailArgs as z.ZodType<UpdateCustomerEmailArgs>,
    jsonSchema: zodToJsonSchema(UpdateCustomerEmailArgs),
    execute: (args) => conn.runUpdateCustomerEmail(args as UpdateCustomerEmailArgs),
  };

  const MergeCustomerAccountsArgs = z.object({
    oldEmail: z
      .string()
      .email()
      .describe("The customer's CURRENT email on the duplicate / soft-to-be-deleted account. This account's transactions + credits will be moved to the newEmail account, then this account is soft-deleted (active=false)."),
    newEmail: z
      .string()
      .email()
      .describe('The email of the SURVIVING account — the one the customer will keep using. Transactions and credits from the oldEmail account will be reassigned to this user.'),
    confirm: z
      .boolean()
      .default(false)
      .describe(
        'Pass true ONLY after the user has explicitly confirmed (e.g. replied "yes" / "si"). On the first call (confirm=false) the tool returns a preview asking for confirmation; do NOT auto-confirm.',
      ),
  });
  type MergeCustomerAccountsArgs = z.infer<typeof MergeCustomerAccountsArgs>;
  const mergeCustomerAccountsTool: ToolDef<MergeCustomerAccountsArgs> = {
    name: 'gantri.merge_customer_accounts',
    description: [
      'Merge two duplicate Gantri customer accounts. Moves all of `oldEmail`\'s transactions + credit ledger rows onto `newEmail`\'s account, copies firstName/lastName ONLY if the destination is empty, and soft-deletes the old account (active=false). Atomic — Porter wraps the whole thing in a DB transaction.',
      'CX or ADMIN role only — fails with FORBIDDEN otherwise.',
      'TWO-STEP CONFIRM: first call without confirm:true returns a preview (both userIds, order count, klaviyo-conflict flag); relay the preview to the user, wait for explicit "yes" / "si" in the NEXT message, then re-call with confirm:true. NEVER auto-confirm.',
      'Use when CX says: "merge accounts", "cuentas duplicadas", "duplicate account", "she has two accounts", "fusionar cuentas", "Han Nguyen needs his order moved to his new account", "merge old@x.com into new@y.com", "cliente creó cuenta de nuevo con email correcto, mueve los pedidos", or relays a CX ticket about an account dedup.',
      'Klaviyo merge is NOT done by this tool. If both accounts have linked Klaviyo profiles the preview includes a warning so the operator knows manual reconciliation is needed in Klaviyo.',
      'When PORTER_WRITE_TARGET=staging (default), writes hit stage.api.gantri.com. When set to prod, writes hit production. Surface the target prominently in the user-facing reply.',
    ].join(' '),
    schema: MergeCustomerAccountsArgs as z.ZodType<MergeCustomerAccountsArgs>,
    jsonSchema: zodToJsonSchema(MergeCustomerAccountsArgs),
    execute: (args) => conn.runMergeCustomerAccounts(args as MergeCustomerAccountsArgs),
  };

  return [ordersQuery, orderGet, orderStats, updateCustomerEmailTool, mergeCustomerAccountsTool];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate the daily rollup into the same shape `gantri.order_stats` returns
 * from Porter pagination. Used as the fallback for date ranges that overflow
 * the pagination cap. Note the rollup excludes Cancelled/Lost orders by
 * construction — the response is marked accordingly so the LLM can surface
 * that to the user.
 */
export function aggregateFromRollup(
  rows: RollupRow[],
  args: { dateRange: { startDate: string; endDate: string }; types?: string[] },
  porterTotalCount: number,
  coverage?: { coverageGapDays: number; rollupStart: string | null; requestedStart: string },
): unknown {
  const typesFilter = args.types && args.types.length > 0 ? new Set(args.types) : null;
  const typeAgg: Record<string, { count: number; revenueCents: number }> = {};
  const statusAgg: Record<string, { count: number; revenueCents: number }> = {};
  let totalCount = 0;
  let totalRevenueCents = 0;

  for (const row of rows) {
    for (const [type, v] of Object.entries(row.by_type ?? {})) {
      if (typesFilter && !typesFilter.has(type)) continue;
      typeAgg[type] ??= { count: 0, revenueCents: 0 };
      typeAgg[type].count += v.orders;
      typeAgg[type].revenueCents += v.revenueCents;
      totalCount += v.orders;
      totalRevenueCents += v.revenueCents;
    }
    for (const [status, v] of Object.entries(row.by_status ?? {})) {
      // by_status doesn't carry per-type info, so we can't filter it by `types`
      // perfectly. When a type filter is set we omit the status breakdown to
      // avoid surfacing numbers that don't match the type-filtered totals.
      if (typesFilter) continue;
      statusAgg[status] ??= { count: 0, revenueCents: 0 };
      statusAgg[status].count += v.orders;
      statusAgg[status].revenueCents += v.revenueCents;
    }
  }

  const totalRevenueDollars = round2(totalRevenueCents / 100);
  const coverageWarning = coverage && coverage.coverageGapDays > 0
    ? `Rollup data only starts at ${coverage.rollupStart}; the requested start was ${coverage.requestedStart}. The first ${coverage.coverageGapDays} days of the requested window are NOT included in these totals. Tell the user the partial coverage so they can decide whether to ask for the covered range only or wait for a backfill.`
    : null;
  return {
    period: args.dateRange,
    typesFilter: args.types,
    source: 'rollup' as const,
    note: 'Rollup excludes Cancelled orders only (Lost is included because a Lost order is a real sale whose package did not arrive, usually offset by a corresponding Refund row that the rollup also captures). Numbers match Grafana Sales. Refund-type rows are negative (net of refunds).',
    porterTotalCount,
    totalOrders: totalCount,
    totalRevenueDollars,
    avgOrderValueDollars: totalCount > 0 ? round2(totalRevenueDollars / totalCount) : 0,
    statusBreakdown: typesFilter
      ? null
      : Object.entries(statusAgg)
          .map(([status, v]) => ({ status, count: v.count, revenueDollars: round2(v.revenueCents / 100) }))
          .sort((a, b) => b.count - a.count),
    typeBreakdown: Object.entries(typeAgg)
      .map(([type, v]) => ({ type, count: v.count, revenueDollars: round2(v.revenueCents / 100) }))
      .sort((a, b) => b.count - a.count),
    truncated: false,
    ...(coverageWarning ? { coverageGapDays: coverage!.coverageGapDays, rollupStart: coverage!.rollupStart, warning: coverageWarning } : {}),
  };
}


/**
 * Compute the order total in cents from the Porter `amount` JSON.
 *
 * Retail `Order` transactions store a precomputed `total` (already net of
 * discounts, including tax + shipping). Wholesale, Trade, and some other
 * non-Stripe transaction types skip `total` entirely — they just carry the
 * component pieces. Falling through to 0 in those cases makes wholesale
 * revenue collapse to $0 in any aggregate.
 *
 * Resolution order:
 *  1. `amount.total` if present → already the right number.
 *  2. Sum of `subtotal + shipping + tax` (the canonical billed components).
 *  3. null when nothing is parseable.
 */
function computeTotalCents(amt: Record<string, unknown>): number | null {
  if (typeof amt.total === 'number') return amt.total;
  const sub = typeof amt.subtotal === 'number' ? amt.subtotal : null;
  const ship = typeof amt.shipping === 'number' ? amt.shipping : 0;
  const tax = typeof amt.tax === 'number' ? amt.tax : 0;
  if (sub === null) return null;
  return sub + ship + tax;
}
