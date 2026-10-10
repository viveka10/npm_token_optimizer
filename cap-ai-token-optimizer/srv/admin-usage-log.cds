using { cap.ai.token_optimizer as db } from '../db/token-usage-log';
using from './admin-service';

/** Added to the admin service when both the admin service and the db exporter are enabled. */
extend service TokenOptimizerService with {
  @readonly
  entity UsageLog as projection on db.TokenUsageLog;
}
