import { randomUUID } from 'node:crypto';
import { withGenAiSpan } from '@fuse/otel';
import type { FuseGuard } from '@fuse/sdk';
import type { ChatCompletionResponse } from '@fuse/sdk/providers';

export interface GuardedChatOptions {
  guard: FuseGuard;
  providerName: string;
  requestModel: string;
  dispatch: () => Promise<ChatCompletionResponse>;
  correlationId?: string;
  sessionId?: string;
  scenario?: string;
}

/** Runs a real chat completion behind both the permit check and OTel span. */
export async function runGuardedInstrumentedChat(
  options: GuardedChatOptions,
): Promise<ChatCompletionResponse> {
  const correlationId = options.correlationId ?? randomUUID();
  const sessionId = options.sessionId ?? randomUUID();
  const scope = options.guard.scope;

  return options.guard.guard(
    () =>
      withGenAiSpan(
        {
          operationName: 'chat',
          providerName: options.providerName,
          requestModel: options.requestModel,
          tenant: scope.tenant,
          environment: scope.environment,
          agentId: scope.agentId,
          sessionId,
          scenario: options.scenario ?? 'real-provider-demo',
          stepIndex: 0,
          correlationId,
          conversationId: sessionId,
          onTelemetryObserved: (observation) =>
            options.guard.recordSpanTelemetry(observation),
        },
        async () => {
          const result = await options.dispatch();
          return {
            result,
            outcome: {
              responseModel: result.model,
              inputTokens: result.usage.prompt_tokens,
              outputTokens: result.usage.completion_tokens,
              finishReasons: result.choices.map((choice) => choice.finish_reason),
              outcome: 'success',
            },
          };
        },
      ),
    correlationId,
  );
}
