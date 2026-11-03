export interface ProcessResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** True if either stream exceeded `maxOutputBytes` and was cut. */
	readonly truncated: boolean;
}

export interface ProcessOptions {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	/** Per stream. Output past this is drained and discarded. */
	readonly maxOutputBytes: number;
	readonly stdin?: string;
}

/** Collect at most `max` bytes from a stream, draining (and discarding) the rest. */
async function collect(
	stream: ReadableStream<Uint8Array>,
	max: number,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for await (const chunk of stream) {
		if (size < max) {
			const take = chunk.subarray(0, max - size);
			chunks.push(take);
			size += take.length;
			if (take.length < chunk.length) truncated = true;
		} else {
			truncated = true;
		}
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

/**
 * Run a program with an argument list (never a shell string, so arguments cannot be
 * interpreted as shell syntax), an explicit environment, a timeout and bounded output.
 */
export async function runProcess(
	argv: readonly string[],
	options: ProcessOptions,
): Promise<ProcessResult> {
	const proc = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: { ...options.env },
		stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, options.timeoutMs);
	try {
		const [out, err, code] = await Promise.all([
			collect(proc.stdout, options.maxOutputBytes),
			collect(proc.stderr, options.maxOutputBytes),
			proc.exited,
		]);
		return {
			code: timedOut ? null : code,
			stdout: out.text,
			stderr: err.text,
			timedOut,
			truncated: out.truncated || err.truncated,
		};
	} finally {
		clearTimeout(timer);
	}
}
