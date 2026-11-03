import type { IdGeneratorPort } from "@superagent/domain";

export class UuidGenerator implements IdGeneratorPort {
	next(): string {
		return crypto.randomUUID();
	}
}
