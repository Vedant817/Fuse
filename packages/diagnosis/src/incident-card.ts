import type { DiagnosisResult } from '@fuse/contracts';

/** Extra context the diagnosis result alone doesn't carry — task.md §7.3's
 * compact incident card needs the breaker/Preflight state alongside the
 * diagnosis itself. */
export interface IncidentCardContext {
  correlationId: string;
  /** Present only once a resume action can actually be authorized — the
   * card's Resume button (when rendered for real Slack) carries this. */
  resumeActionValue?: string;
  /** The current committed state read for this exact incident scope. `unknown`
   * means that no committed result could be read; it must never be promoted to
   * `protected` by a card-rendering fallback. */
  preflightState: 'protected' | 'degraded' | 'blind' | 'disabled' | 'unknown';
}

export interface IncidentCardBlocks {
  /** Slack Block Kit blocks, ready for `chat.postMessage`'s `blocks` field. */
  blocks: unknown[];
  /** Plain-text fallback (Slack's own `text` field, shown in notifications
   * and by clients that don't render blocks). */
  text: string;
}

function confidenceLabel(confidence: DiagnosisResult['confidence']): string {
  return { low: 'Low', medium: 'Medium', high: 'High' }[confidence];
}

/**
 * Builds the compact incident card task.md §7.3 asks for: state, scope,
 * reason, evidence, confidence, Preflight status, proposed fix, and
 * authorized actions. Pure data in, pure data out — the same blocks are
 * used both for a real Slack post (§7.3b) and the local no-network
 * renderer (`renderLocalIncidentCardHtml`, this file) so the two can never
 * drift apart from having two independent implementations.
 */
export function buildIncidentCardBlocks(
  diagnosis: DiagnosisResult,
  context: IncidentCardContext,
): IncidentCardBlocks {
  const scopeLine = `${diagnosis.scope.tenant}/${diagnosis.scope.environment}/${diagnosis.scope.agentId}`;
  const title = `🔴 Fuse tripped: ${diagnosis.detector} — ${scopeLine}`;

  const evidenceLines =
    diagnosis.evidenceLinks.length > 0
      ? diagnosis.evidenceLinks
          .map((l) => (l.webUrl ? `<${l.webUrl}|${l.traceId.slice(0, 12)}…>` : l.traceId))
          .join(', ')
      : 'no trace evidence available';

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Detector*\n${diagnosis.detector}` },
        {
          type: 'mrkdwn',
          text: `*Confidence*\n${confidenceLabel(diagnosis.confidence)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Preflight*\n${context.preflightState}`,
        },
        { type: 'mrkdwn', text: `*Correlation*\n${context.correlationId}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Hypothesis*\n${diagnosis.hypothesis}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason*\n${diagnosis.supportingEvidence.map((e) => `• ${e}`).join('\n')}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Immediate containment*\n${diagnosis.immediateContainment}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Recommended fix*\n${diagnosis.recommendedFix}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Evidence*\n${evidenceLines}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: diagnosis.limitations.map((l) => `⚠️ ${l}`).join('\n'),
        },
      ],
    },
  ];

  if (context.resumeActionValue) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Resume (requires reason)' },
          style: 'primary',
          action_id: 'fuse_resume',
          value: context.resumeActionValue,
          confirm: {
            title: { type: 'plain_text', text: 'Resume this scope?' },
            text: {
              type: 'plain_text',
              text: `This will resume ${scopeLine}. You will be asked for a reason.`,
            },
            confirm: { type: 'plain_text', text: 'Resume' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }

  return {
    blocks,
    text: `${title} — ${diagnosis.hypothesis}`,
  };
}

/** No-network local renderer (task.md §7.3: "a no-network local renderer/
 * snapshot for reliable demo rehearsal"). Renders the exact same
 * `buildIncidentCardBlocks` output as a self-contained HTML snapshot —
 * never calls Slack, never requires a token. */
export function renderLocalIncidentCardHtml(
  diagnosis: DiagnosisResult,
  context: IncidentCardContext,
): string {
  const card = buildIncidentCardBlocks(diagnosis, context);
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fuse incident card (local snapshot)</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1d21; color: #d1d2d3; padding: 24px; }
  .card { max-width: 640px; margin: 0 auto; background: #222529; border-radius: 8px; padding: 20px; border: 1px solid #3a3d42; }
  h1 { font-size: 18px; }
  .field { margin: 12px 0; }
  .label { font-weight: 600; color: #fff; }
  .warn { color: #ecb22e; font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <h1>${escape(card.text.split(' — ')[0] ?? 'Fuse incident')}</h1>
    <div class="field"><span class="label">Hypothesis:</span> ${escape(diagnosis.hypothesis)}</div>
    <div class="field"><span class="label">Reason:</span> ${diagnosis.supportingEvidence.map((e) => escape(e)).join('; ')}</div>
    <div class="field"><span class="label">Immediate containment:</span> ${escape(diagnosis.immediateContainment)}</div>
    <div class="field"><span class="label">Recommended fix:</span> ${escape(diagnosis.recommendedFix)}</div>
    <div class="field"><span class="label">Confidence:</span> ${confidenceLabel(diagnosis.confidence)}</div>
    <div class="field"><span class="label">Preflight:</span> ${context.preflightState}</div>
    <div class="field"><span class="label">Evidence links:</span> ${diagnosis.evidenceLinks.length}</div>
    ${diagnosis.limitations.map((l) => `<div class="warn">⚠️ ${escape(l)}</div>`).join('\n    ')}
  </div>
  <!-- Rendered locally, no network call to Slack was made. -->
</body></html>`;
}
