import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../services/api";

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SSEStartOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: BodyInit | null | undefined;
  signal?: AbortSignal | undefined;
  onOpen?: (response: Response) => void;
  onMessage?: (event: SSEMessage) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

interface PendingSSEEvent {
  event?: string;
  id?: string;
  dataLines: string[];
}

const EMPTY_PENDING_EVENT: PendingSSEEvent = {
  dataLines: []
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function parseSSEStream(
  response: Response,
  handlers: {
    onMessage: ((event: SSEMessage) => void) | undefined;
    onLastEventAt: (value: number) => void;
  }
): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new ApiClientError("SSE response has no body", response.status);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: PendingSSEEvent = { ...EMPTY_PENDING_EVENT };

  const dispatch = (): void => {
    if (pending.dataLines.length === 0) {
      pending = { ...EMPTY_PENDING_EVENT };
      return;
    }

    const payload: SSEMessage = {
      event: pending.event ?? "message",
      data: pending.dataLines.join("\n")
    };
    if (pending.id !== undefined) {
      payload.id = pending.id;
    }

    handlers.onLastEventAt(Date.now());
    handlers.onMessage?.(payload);
    pending = { ...EMPTY_PENDING_EVENT };
  };

  const processLine = (line: string): void => {
    if (line.length === 0) {
      dispatch();
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    switch (field) {
      case "event":
        pending.event = value.length > 0 ? value : "message";
        break;
      case "data":
        pending.dataLines.push(value);
        break;
      case "id":
        pending.id = value;
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const lineBreak = buffer.indexOf("\n");
      if (lineBreak < 0) {
        break;
      }

      const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
      buffer = buffer.slice(lineBreak + 1);
      processLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const trailingLines = buffer.split(/\r?\n/);
    for (const line of trailingLines) {
      processLine(line);
    }
  }
  dispatch();
}

export function useSSE() {
  const controllerRef = useRef<AbortController | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsConnecting(false);
    setIsConnected(false);
  }, []);

  const start = useCallback(async (options: SSEStartOptions): Promise<void> => {
    stop();

    setError(null);
    setIsConnecting(true);
    setIsConnected(false);

    const controller = new AbortController();
    controllerRef.current = controller;

    const externalSignal = options.signal;
    let externalAbortListener: (() => void) | undefined;

    if (externalSignal) {
      externalAbortListener = () => controller.abort(externalSignal.reason);
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", externalAbortListener, { once: true });
      }
    }

    try {
      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        headers: {
          Accept: "text/event-stream",
          ...(options.headers ?? {})
        },
        signal: controller.signal
      };
      if (options.body !== undefined) {
        requestInit.body = options.body;
      }

      const response = await fetch(options.url, requestInit);

      if (!response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as Record<string, unknown>;
          const message =
            typeof payload.error === "string"
              ? payload.error
              : `SSE request failed with status ${response.status}`;
          throw new ApiClientError(message, response.status, payload.details);
        }

        const text = await response.text();
        throw new ApiClientError(
          text.trim().length > 0 ? text : `SSE request failed with status ${response.status}`,
          response.status
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new ApiClientError("Response is not an SSE stream", response.status);
      }

      options.onOpen?.(response);
      setIsConnecting(false);
      setIsConnected(true);

      await parseSSEStream(response, {
        onMessage: options.onMessage,
        onLastEventAt: setLastEventAt
      });

      setIsConnected(false);
      options.onClose?.();
    } catch (error) {
      const parsedError = toError(error);
      if (parsedError.name === "AbortError") {
        setIsConnecting(false);
        setIsConnected(false);
        options.onClose?.();
        return;
      }

      setError(parsedError);
      setIsConnecting(false);
      setIsConnected(false);
      options.onError?.(parsedError);
      options.onClose?.();
      throw parsedError;
    } finally {
      if (externalSignal && externalAbortListener) {
        externalSignal.removeEventListener("abort", externalAbortListener);
      }
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  return {
    isConnected,
    isConnecting,
    error,
    lastEventAt,
    start,
    stop
  };
}
