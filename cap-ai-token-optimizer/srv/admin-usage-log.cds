using { cap.ai.token_optimizer as db } from '../db/token-usage-log';
using from './admin-service';

/** Added to the admin service when both the admin service and the db exporter are enabled. */
extend service TokenOptimizerService with {
  @readonly
  entity UsageLog as projection on db.TokenUsageLog;

  /** Totals of UsageLog rows for one time bucket (UTC) and one value of `groupBy`. */
  type UsageBucket {
    /** Start of the hour or day (UTC, ISO 8601); null for interval 'none' */
    bucket              : String;
    /** Value of the `groupBy` column (null without groupBy, or when the column is empty) */
    name                : String;
    calls               : Integer64;
    errors              : Integer64;
    cacheHits           : Integer64;
    promptTokens        : Integer64;
    completionTokens    : Integer64;
    totalTokens         : Integer64;
    cachedTokens        : Integer64;
    savedTokensEstimate : Integer64;
    costEstimate        : Decimal(20, 6);
    latencyAvg          : Integer;
    latencyMax          : Integer;
  }

  /**
   * UsageLog totals in [from, to), aggregated in the database.
   * interval: 'hour', 'day' (default) or 'none'. groupBy: model, useCase, cdsService, status,
   * errorCategory, sdk, operation or resourceGroup; null for overall totals.
   * from defaults to 7 days before `to`, `to` to now.
   */
  function usage(from : Timestamp, to : Timestamp, interval : String, groupBy : String) returns many UsageBucket;
}

// Fiori elements: list report and analytical list page on UsageLog
annotate TokenOptimizerService.UsageLog with @(
  UI.HeaderInfo         : {
    TypeName      : 'AI call',
    TypeNamePlural: 'AI calls',
    Title         : { Value: useCase },
    Description   : { Value: model }
  },
  UI.SelectionFields    : [timestamp, useCase, model, status, errorCategory, cacheHit, cdsService],
  UI.LineItem           : [
    { Value: timestamp },
    { Value: useCase },
    { Value: model },
    { Value: status },
    { Value: promptTokens },
    { Value: completionTokens },
    { Value: totalTokens },
    { Value: savedTokensEstimate },
    { Value: costEstimate },
    { Value: latencyMs },
    { Value: cacheHit },
    { Value: errorCategory }
  ],
  UI.PresentationVariant: {
    SortOrder     : [{ Property: timestamp, Descending: true }],
    Visualizations: ['@UI.LineItem', '@UI.Chart']
  },
  UI.Chart              : {
    Title          : 'Tokens by model',
    ChartType      : #Column,
    Dimensions     : [model],
    DynamicMeasures: ['@Analytics.AggregatedProperty#sumTotalTokens']
  },
  UI.FieldGroup #Tokens : { Data: [
    { Value: promptEstimatedBefore },
    { Value: promptEstimatedAfter },
    { Value: promptTokens },
    { Value: completionTokens },
    { Value: totalTokens },
    { Value: cachedTokens },
    { Value: savedTokensEstimate },
    { Value: costEstimate }
  ] },
  UI.FieldGroup #Call   : { Data: [
    { Value: timestamp },
    { Value: cdsService },
    { Value: mode },
    { Value: sdk },
    { Value: operation },
    { Value: deploymentId },
    { Value: resourceGroup },
    { Value: requestId },
    { Value: finishReason },
    { Value: latencyMs },
    { Value: retries },
    { Value: cacheHit },
    { Value: promptPrefixChanged }
  ] },
  UI.FieldGroup #Error  : { Data: [
    { Value: errorCategory },
    { Value: errorHttpStatus },
    { Value: errorCode },
    { Value: errorMessage }
  ] },
  UI.Facets             : [
    { $Type: 'UI.ReferenceFacet', Label: 'Tokens', Target: '@UI.FieldGroup#Tokens' },
    { $Type: 'UI.ReferenceFacet', Label: 'Call', Target: '@UI.FieldGroup#Call' },
    { $Type: 'UI.ReferenceFacet', Label: 'Error', Target: '@UI.FieldGroup#Error' }
  ],
  Aggregation.ApplySupported: {
    Transformations       : ['aggregate', 'topcount', 'bottomcount', 'identity', 'concat', 'groupby', 'filter', 'search'],
    Rollup                : #None,
    PropertyRestrictions  : true,
    GroupableProperties   : [timestamp, tenant, cdsService, useCase, mode, model, deploymentId, resourceGroup, sdk, operation, finishReason, status, errorCategory, cacheHit],
    AggregatableProperties: [
      { Property: promptTokens },
      { Property: completionTokens },
      { Property: totalTokens },
      { Property: cachedTokens },
      { Property: savedTokensEstimate },
      { Property: costEstimate },
      { Property: latencyMs }
    ]
  },
  Analytics.AggregatedProperty #sumTotalTokens         : { Name: 'sumTotalTokens', AggregationMethod: 'sum', AggregatableProperty: totalTokens, @Common.Label: 'Total tokens' },
  Analytics.AggregatedProperty #sumPromptTokens        : { Name: 'sumPromptTokens', AggregationMethod: 'sum', AggregatableProperty: promptTokens, @Common.Label: 'Prompt tokens' },
  Analytics.AggregatedProperty #sumCompletionTokens    : { Name: 'sumCompletionTokens', AggregationMethod: 'sum', AggregatableProperty: completionTokens, @Common.Label: 'Completion tokens' },
  Analytics.AggregatedProperty #sumSavedTokensEstimate : { Name: 'sumSavedTokensEstimate', AggregationMethod: 'sum', AggregatableProperty: savedTokensEstimate, @Common.Label: 'Tokens saved (estimate)' },
  Analytics.AggregatedProperty #sumCostEstimate        : { Name: 'sumCostEstimate', AggregationMethod: 'sum', AggregatableProperty: costEstimate, @Common.Label: 'Cost (estimate)' },
  Analytics.AggregatedProperty #avgLatencyMs           : { Name: 'avgLatencyMs', AggregationMethod: 'average', AggregatableProperty: latencyMs, @Common.Label: 'Average latency (ms)' }
) {
  timestamp             @title: 'Time';
  tenant                @title: 'Tenant';
  userHash              @title: 'User (hash)';
  cdsService            @title: 'CDS service';
  useCase               @title: 'Use case';
  mode                  @title: 'Mode';
  model                 @title: 'Model';
  deploymentId          @title: 'Deployment';
  resourceGroup         @title: 'Resource group';
  sdk                   @title: 'SDK';
  operation             @title: 'Operation';
  requestId             @title: 'Request ID';
  finishReason          @title: 'Finish reason';
  promptEstimatedBefore @title: 'Prompt tokens before optimization (estimate)';
  promptEstimatedAfter  @title: 'Prompt tokens after optimization (estimate)';
  promptTokens          @title: 'Prompt tokens'            @Aggregation.default: #SUM;
  completionTokens      @title: 'Completion tokens'        @Aggregation.default: #SUM;
  totalTokens           @title: 'Total tokens'             @Aggregation.default: #SUM;
  cachedTokens          @title: 'Cached tokens'            @Aggregation.default: #SUM;
  savedTokensEstimate   @title: 'Tokens saved (estimate)'  @Aggregation.default: #SUM;
  savingsByStep         @title: 'Tokens saved per step'    @UI.Hidden;
  cacheHit              @title: 'Cache hit';
  promptPrefixChanged   @title: 'Prompt prefix changed';
  costEstimate          @title: 'Cost (estimate)'          @Aggregation.default: #SUM;
  latencyMs             @title: 'Latency (ms)'             @Aggregation.default: #AVG;
  retries               @title: 'Retries';
  status                @title: 'Status';
  errorCategory         @title: 'Error category';
  errorHttpStatus       @title: 'HTTP status';
  errorCode             @title: 'Error code';
  errorMessage          @title: 'Error message';
  promptHash            @title: 'Prompt hash'              @UI.Hidden;
  promptLength          @title: 'Prompt length';
  ID                    @UI.Hidden;
}
