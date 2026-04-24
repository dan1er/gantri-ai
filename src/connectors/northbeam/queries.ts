/**
 * Northbeam internal GraphQL operations.
 * Endpoint: POST https://dashboard-api.northbeam.io/api/graphql
 * Reverse-engineered 2026-04-24; see `reference_northbeam_api` memory.
 */

export const GET_OVERVIEW_METRICS_REPORT_V3 = `
query GetOverviewMetricsReportV3(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $advancedSearch: JSONObject, $sorting: [SalesSortingInput!]
) {
  me {
    overviewMetricsReportV3(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      metricIds: $metricIds, breakdownFilters: $breakdownFilters,
      advancedSearch: $advancedSearch, sorting: $sorting
    ) {
      rows
      summary { actual comparison }
    }
  }
}`;

export const GET_SALES_METRICS_REPORT_V4 = `
query GetSalesMetricsReportV4(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $advancedSearch: JSONObject,
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $universalBenchmarkBreakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $campaignHashFilters: [String!], $adsetHashFilters: [String!], $adHashFilters: [String!],
  $statusFilters: [String!],
  $metricFilters: [SalesMetricFilterInput!], $metricFiltersClauseType: String,
  $sorting: [SalesSortingInput!], $limit: Int, $offset: Int,
  $isSummary: Boolean, $summaryDimensionIds: [String!]
) {
  me {
    salesMetricsReportV4(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      metricIds: $metricIds, advancedSearch: $advancedSearch,
      breakdownFilters: $breakdownFilters,
      universalBenchmarkBreakdownFilters: $universalBenchmarkBreakdownFilters,
      campaignHashFilters: $campaignHashFilters, adsetHashFilters: $adsetHashFilters,
      adHashFilters: $adHashFilters, statusFilters: $statusFilters,
      metricFilters: $metricFilters, metricFiltersClauseType: $metricFiltersClauseType,
      sorting: $sorting, limit: $limit, offset: $offset,
      isSummary: $isSummary, summaryDimensionIds: $summaryDimensionIds
    ) {
      actual comparison
    }
  }
}`;

export const GET_SALES_METRICS_COUNT_V4 = `
query GetSalesMetricsCountV4(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $advancedSearch: JSONObject,
  $campaignHashFilters: [String!], $adsetHashFilters: [String!], $adHashFilters: [String!],
  $statusFilters: [String!],
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $universalBenchmarkBreakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $metricFilters: [SalesMetricFilterInput!], $metricFiltersClauseType: String
) {
  me {
    salesMetricsCountV4(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      statusFilters: $statusFilters, metricIds: $metricIds,
      advancedSearch: $advancedSearch,
      campaignHashFilters: $campaignHashFilters, adsetHashFilters: $adsetHashFilters,
      adHashFilters: $adHashFilters, breakdownFilters: $breakdownFilters,
      universalBenchmarkBreakdownFilters: $universalBenchmarkBreakdownFilters,
      metricFilters: $metricFilters, metricFiltersClauseType: $metricFiltersClauseType
    ) { total }
  }
}`;

export const GET_SALES_BREAKDOWN_CONFIGS = `
query GetSalesBreakdownConfigs {
  me {
    id
    salesBreakdownConfigs {
      key name
      choices { value label }
    }
  }
}`;

export const FETCH_PARTNERS_APEX_CONSENT = `
query FetchPartnersApexConsent {
  me {
    partnerApexConsent {
      partner permission hasConsent hasConnectedAccounts connectedAccountValidationWarning
    }
    isMetaCapiConfigured
  }
}`;

export const FETCH_ORDER_SUMMARY = `
query FetchOrderSummary($filterOptions: OrdersFilterOptionsInput!, $sorting: OrdersSortingInput, $offset: Int, $limit: Int) {
  me {
    orders(filterOptions: $filterOptions, sorting: $sorting, offset: $offset, limit: $limit) {
      data {
        orderId
        occurredAt
        orderType
        orderNumber
        revenueInDollars
        discountValue
        shippingValue
        taxValue
        refundAmountInDollars
        attributed
        orderTags
        sourceName
        customerTags
        discountCodes
        customerId
        customerEmail
        numberOfTouchpoints
        newNumberOfTouchpoints
        subscriptionType
        products { title quantity }
      }
      totalCount
    }
  }
}`;

export const FETCH_ORDER_SUMMARY_GRAPH_KPI = `
query FetchOrderSummaryGraphKPI($dateRange: DateRangeInput!, $comparedDateRange: DateRangeInput!, $filterOptions: OrdersGraphFilterOptionsInput) {
  me {
    orderSummaryGraphKPI(dateRange: $dateRange, comparedDateRange: $comparedDateRange, filterOptions: $filterOptions) {
      currentKPIs { orderRevenue orderCount }
      comparisonKPIs { orderRevenue orderCount }
    }
  }
}`;

export const GET_METRICS_EXPLORER_REPORT = `
query GetMetricsExplorerReport(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $advancedSearch: JSONObject,
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $isSummary: Boolean
) {
  me {
    metricsExplorerReport(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      dimensionIds: $dimensionIds, metricIds: $metricIds,
      advancedSearch: $advancedSearch, breakdownFilters: $breakdownFilters,
      isSummary: $isSummary
    ) {
      rows
      summary
    }
  }
}`;

export const FETCH_ORDER_SUMMARY_GRAPH = `
query FetchOrderSummaryGraph($dateRange: DateRangeInput!, $granularity: String!, $filterOptions: OrdersGraphFilterOptionsInput) {
  me {
    orderSummaryGraph(dateRange: $dateRange, granularity: $granularity, filterOptions: $filterOptions) {
      data { orderRevenue orderCount datetime }
    }
  }
}`;
