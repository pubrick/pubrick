import { SetMetadata } from "@nestjs/common";
import type { PublicWriteOperation } from "@pubrick/shared";

export const REQUIRED_API_KEY_OPERATION = "required_api_key_operation";
/** Server route metadata only. A write scope alone cannot authorize a domain operation. */
export const RequiredApiKeyOperation = (operation: PublicWriteOperation) =>
  SetMetadata(REQUIRED_API_KEY_OPERATION, operation);
