/**
 * Read-only statistics of @viveka10/cap-ai-token-optimizer for this app instance (in-memory, since
 * start or the last reset). Served at /odata/v4/token-optimizer when
 * cds.requires.tokenOptimizer.admin.enabled is true. The required role is
 * cds.requires.tokenOptimizer.admin.role (default TokenOptimizerAdmin).
 */
@path    : 'token-optimizer'
@requires: 'TokenOptimizerAdmin'
@readonly
service TokenOptimizerService {

  type Tokens {
    prompt     : Integer64;
    completion : Integer64;
    total      : Integer64;
    cached     : Integer64;
  }

  type Latency {
    count : Integer;
    avg   : Integer;
    p50   : Integer;
    p95   : Integer;
    max   : Integer;
  }

  aspect Totals {
    calls               : Integer64;
    success             : Integer64;
    errors              : Integer64;
    cacheHits           : Integer64;
    tokens              : Tokens;
    savedTokensEstimate : Integer64;
    costEstimate        : Decimal(20, 6);
  }

  type Summary : Totals {
    since          : Timestamp;
    mode           : String;
    latencyMs      : Latency;
    listenerErrors : Integer;
  }

  /** Totals for this app instance. */
  function summary() returns Summary;

  @cds.persistence.skip
  entity UseCases : Totals {
    key name : String;
  }

  @cds.persistence.skip
  entity Models : Totals {
    key name : String;
  }

  @cds.persistence.skip
  entity ErrorCategories {
    key category : String;
        count    : Integer64;
  }

  @cds.persistence.skip
  entity StepSavings {
    key step   : String;
        tokens : Integer64;
  }

  /** Prompt-caching advisory: calls whose system prompt or tools changed, per use case. */
  @cds.persistence.skip
  entity PromptPrefixChanges {
    key useCase : String;
        count   : Integer64;
  }

  @cds.persistence.skip
  entity Exporters {
    key name   : String;
        errors : Integer64;
        /** JSON from the exporter's stats(), e.g. queued, sent, dropped for http */
        stats  : LargeString;
  }
}
