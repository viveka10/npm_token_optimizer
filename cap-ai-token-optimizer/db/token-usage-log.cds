namespace cap.ai.token_optimizer;

/**
 * One row per AI Core call, written by the `db` metrics exporter (alias `hana`).
 * Contains metrics only: never prompt or completion text. In multitenant apps each tenant's
 * calls are written to that tenant's database container.
 */
entity TokenUsageLog {
  key ID                    : UUID;
      timestamp             : Timestamp;
      tenant                : String(255);
      userHash              : String(16);
      cdsService            : String(255);
      useCase               : String(255);
      mode                  : String(10);
      model                 : String(255);
      deploymentId          : String(255);
      resourceGroup         : String(255);
      sdk                   : String(30);
      operation             : String(10);
      requestId             : String(255);
      finishReason          : String(50);
      promptEstimatedBefore : Integer;
      promptEstimatedAfter  : Integer;
      promptTokens          : Integer;
      completionTokens      : Integer;
      totalTokens           : Integer;
      cachedTokens          : Integer;
      savedTokensEstimate   : Integer;
      /** JSON object: estimated tokens saved per step */
      savingsByStep         : LargeString;
      cacheHit              : Boolean;
      promptPrefixChanged   : Boolean;
      costEstimate          : Decimal(20, 6);
      latencyMs             : Integer;
      retries               : Integer;
      status                : String(10);
      errorCategory         : String(30);
      errorHttpStatus       : Integer;
      errorCode             : String(100);
      errorMessage          : String(300);
      promptHash            : String(64);
      promptLength          : Integer;
}
