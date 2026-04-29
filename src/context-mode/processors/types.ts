import type { ContextModeProcessorFamily } from "../../types.js";

export interface ProcessorInvariant {
  key: ContextModeProcessorFamily;
  maxBytes: number;
  preserve: ReadonlyArray<string>;
}

export interface ProcessorOutput {
  text: string;
  processorKey: ContextModeProcessorFamily;
  passthrough: boolean;
}

export interface ProcessorContext {
  exitCode: number | null;
  eol: "\n" | "\r\n";
}

export type Processor = (text: string, ctx: ProcessorContext) => ProcessorOutput;
