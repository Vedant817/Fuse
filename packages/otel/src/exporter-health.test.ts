import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { ExporterHealthSpanExporter } from './exporter-health.js';

function readableSpan(): ReadableSpan {
  return {
    attributes: {
      'fuse.tenant': 't1',
      'fuse.environment': 'test',
      'fuse.agent_id': 'agent-1',
      'gen_ai.request.model': 'model-1',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
    },
    startTime: [100, 0],
    endTime: [100, 1_000_000],
    parentSpanContext: undefined,
  } as unknown as ReadableSpan;
}

class ControlledExporter implements SpanExporter {
  readonly callbacks: Array<(result: { code: number }) => void> = [];
  flushError: Error | undefined;

  export(_spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void {
    this.callbacks.push(callback);
  }

  complete(index: number, code: number): void {
    this.callbacks[index]!({ code });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return this.flushError ? Promise.reject(this.flushError) : Promise.resolve();
  }
}

describe('ExporterHealthSpanExporter', () => {
  it('assigns invocation-order sequence numbers even when exports complete out of order', () => {
    const delegate = new ControlledExporter();
    const observed: Array<{
      status: string;
      sourceInstanceId: string;
      sequence: number;
    }> = [];
    const exporter = new ExporterHealthSpanExporter(
      delegate,
      (result) => {
        observed.push(result.exporterDelivery);
      },
      200,
      () => 123,
      'process-1',
    );

    exporter.export([readableSpan()], vi.fn());
    exporter.export([readableSpan()], vi.fn());
    delegate.complete(1, 1);
    delegate.complete(0, 0);

    expect(observed).toEqual([
      {
        status: 'failure',
        observedAtMs: 123,
        sourceInstanceId: 'process-1',
        sequence: 2,
      },
      {
        status: 'success',
        observedAtMs: 123,
        sourceInstanceId: 'process-1',
        sequence: 1,
      },
    ]);
  });

  it('bounds source identity and waits for asynchronous observers during shutdown', async () => {
    expect(
      () =>
        new ExporterHealthSpanExporter(
          new ControlledExporter(),
          () => {},
          200,
          Date.now,
          'invalid source with spaces',
        ),
    ).toThrow(/sourceInstanceId/);

    const delegate = new ControlledExporter();
    let release!: () => void;
    const observer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exporter = new ExporterHealthSpanExporter(
      delegate,
      () => observer,
      200,
      Date.now,
      'process-1',
    );
    exporter.export([readableSpan()], vi.fn());
    delegate.complete(0, 0);

    let shutDown = false;
    const shutdown = exporter.shutdown().then(() => {
      shutDown = true;
    });
    await Promise.resolve();
    expect(shutDown).toBe(false);
    release();
    await shutdown;
    expect(shutDown).toBe(true);
  });

  it('drains failure evidence before preserving a delegate flush error', async () => {
    const delegate = new ControlledExporter();
    delegate.flushError = new Error('delegate flush failed');
    let release!: () => void;
    const observer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exporter = new ExporterHealthSpanExporter(
      delegate,
      () => observer,
      200,
      Date.now,
      'process-1',
    );
    exporter.export([readableSpan()], vi.fn());

    let settled = false;
    const flush = exporter.forceFlush().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    delegate.complete(0, 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(flush).rejects.toThrow('delegate flush failed');
    expect(settled).toBe(true);
  });
});
