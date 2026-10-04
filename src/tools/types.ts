import {z} from 'zod';

export type ToolContext = {
	/** Directory the agent operates in. */
	cwd: string;
	/** Aborted when the user interrupts; long-running tools should honor it. */
	signal: AbortSignal;
};

export type Tool<S extends z.ZodType = z.ZodType> = {
	name: string;
	description: string;
	/** Zod schema for the arguments; converted to JSON Schema for the model and used for validation. */
	schema: S;
	/** If true, the user is asked before each call (unless they chose "always" for this session). */
	requiresApproval: boolean;
	/** Short human-readable summary of a call, shown in the chat and approval prompt. */
	describe: (args: z.infer<S>) => string;
	/** Optional longer preview shown in the approval prompt (e.g. file contents or a diff). */
	preview?: (args: z.infer<S>) => string;
	/** Performs the action. Return text for the model; throw to report an error. */
	run: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

/** Identity helper that gives `run`/`describe` typed arguments inferred from the schema. */
export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
	return tool;
}
