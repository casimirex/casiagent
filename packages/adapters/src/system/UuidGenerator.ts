import type { IdGeneratorPort } from "@casiagent/domain";

export class UuidGenerator implements IdGeneratorPort {
	next(): string {
		return crypto.randomUUID();
	}
}
