// React Query hooks over the operator client, plus the live event stream.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkFunding,
  createCampaign,
  exportViewingKey,
  getCampaign,
  getCampaignReceipt,
  getHealth,
  listCampaigns,
  OperatorApiError,
  recordFunding,
  startCampaign,
  type CreateCampaignInput,
} from "@/api/operator/client";
import { subscribeToEvents, type StreamStatus } from "@/api/operator/events";
import type { OperatorCampaign, ProgressEvent, ViewingKeyExport } from "@/api/operator/schemas";
import { getToken, rejectToken, useSession } from "@/api/operator/session";
import type { OutPointView } from "@/api/types";

export const operatorKeys = {
  health: ["operator", "health"] as const,
  campaigns: ["operator", "campaigns"] as const,
  campaign: (id: string) => ["operator", "campaign", id] as const,
  receipt: (id: string) => ["operator", "receipt", id] as const,
};

/** Retry only "could not reach it". Everything else is an answer, not a glitch. */
const retryUnreachable = (count: number, error: unknown): boolean =>
  error instanceof OperatorApiError && error.kind === "unreachable" && count < 2;

/** Whether the session may call protected endpoints at all. */
function useReady(): boolean {
  return useSession((s) => s.status) === "ready";
}

/** The operator's network and whether it is on the mock chain. No token needed. */
export function useHealth() {
  return useQuery({
    queryKey: operatorKeys.health,
    queryFn: ({ signal }) => getHealth(signal),
    retry: retryUnreachable,
    staleTime: 30_000,
  });
}

export function useCampaigns() {
  const ready = useReady();
  return useQuery({
    queryKey: operatorKeys.campaigns,
    queryFn: ({ signal }) => listCampaigns(signal),
    enabled: ready,
    retry: retryUnreachable,
  });
}

/** How often to look again while waiting for a deposit on a real chain. The
 * operator polls the chain itself; this only picks up what it found. */
const FUNDING_REFRESH_MS = 5_000;

/** One campaign. While a run is going, also looks again every two seconds as a
 * safety net beside the event stream, and every few seconds while a real-chain
 * campaign waits for its deposit. */
export function useCampaign(id: string) {
  const ready = useReady();
  return useQuery({
    queryKey: operatorKeys.campaign(id),
    queryFn: ({ signal }) => getCampaign(id, signal),
    enabled: ready,
    retry: retryUnreachable,
    refetchInterval: (query) => {
      const campaign = query.state.data;
      if (campaign === undefined) return false;
      if (campaign.run.state === "running") return 2_000;
      if (campaign.funding === null && campaign.fundingAddress !== null) return FUNDING_REFRESH_MS;
      return false;
    },
  });
}

/** The receipt the operator builds. Only meaningful once funded; before that the
 * operator answers 409 `not_funded`, which is an expected state, not a failure. */
export function useCampaignReceipt(id: string, enabled: boolean) {
  const ready = useReady();
  return useQuery({
    queryKey: operatorKeys.receipt(id),
    queryFn: ({ signal }) => getCampaignReceipt(id, signal),
    enabled: ready && enabled,
    retry: retryUnreachable,
  });
}

/** After anything that changes a campaign: refresh it, its receipt and the list. */
function useRefreshCampaign() {
  const queryClient = useQueryClient();
  return useCallback(
    async (id: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: operatorKeys.campaign(id) }),
        queryClient.invalidateQueries({ queryKey: operatorKeys.receipt(id) }),
        queryClient.invalidateQueries({ queryKey: operatorKeys.campaigns }),
      ]);
    },
    [queryClient],
  );
}

export function useStartCampaign(id: string) {
  const refresh = useRefreshCampaign();
  return useMutation({
    mutationFn: () => startCampaign(id),
    onSettled: () => refresh(id),
  });
}

/** Real chain: look for the deposit now instead of waiting for the next poll. */
export function useCheckFunding(id: string) {
  const refresh = useRefreshCampaign();
  return useMutation({
    mutationFn: () => checkFunding(id),
    onSettled: () => refresh(id),
  });
}

export function useRecordFunding(id: string) {
  const refresh = useRefreshCampaign();
  return useMutation({
    mutationFn: (deposit: { outpoint: OutPointView; amount: string }) => recordFunding(id, deposit),
    onSettled: () => refresh(id),
  });
}

// ---- creating a campaign ---------------------------------------------------------

export type CreateState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "failed"; error: unknown };

/** Creates a campaign WITHOUT React Query, on purpose: a mutation keeps its
 * `variables` (here, the whole recipient CSV) in the query cache until it is
 * reset. This keeps nothing: the CSV exists only in the caller's argument for
 * the duration of the call. */
export function useCreateCampaign() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CreateState>({ status: "idle" });

  const create = useCallback(
    async (input: CreateCampaignInput): Promise<OperatorCampaign | null> => {
      setState({ status: "creating" });
      try {
        const campaign = await createCampaign(input);
        setState({ status: "idle" });
        await queryClient.invalidateQueries({ queryKey: operatorKeys.campaigns });
        queryClient.setQueryData(operatorKeys.campaign(campaign.id), campaign);
        return campaign;
      } catch (error) {
        setState({ status: "failed", error });
        return null;
      }
    },
    [queryClient],
  );

  const clearError = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  return { state, create, clearError };
}

// ---- the viewing key -------------------------------------------------------------------

export type ViewingKeyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; key: ViewingKeyExport }
  | { status: "failed"; error: unknown };

/** Fetches the campaign's viewing key WITHOUT React Query, on purpose: a query or
 * mutation result sits in the cache after the page is left. This keeps the key
 * in this component's state only, and drops it on `clear()`, on a change of
 * campaign, and when the component goes away. */
export function useViewingKey(id: string) {
  const [held, setHeld] = useState<{ id: string; state: ViewingKeyState }>({ id, state: { status: "idle" } });
  const generation = useRef(0);

  // Answers still on their way are ignored once the page is left or the campaign changes.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [id],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    setHeld({ id, state: { status: "idle" } });
  }, [id]);

  const request = useCallback(async () => {
    const mine = ++generation.current;
    setHeld({ id, state: { status: "loading" } });
    try {
      const key = await exportViewingKey(id);
      if (generation.current === mine) setHeld({ id, state: { status: "ready", key } });
    } catch (error) {
      if (generation.current === mine) setHeld({ id, state: { status: "failed", error } });
    }
  }, [id]);

  // A key fetched for another campaign is never shown for this one.
  const state: ViewingKeyState = held.id === id ? held.state : { status: "idle" };
  return { state, request, clear };
}

// ---- the live event stream --------------------------------------------------------

const LOG_LIMIT = 200;

export interface CampaignStream {
  log: readonly ProgressEvent[];
  status: StreamStatus;
  /** How many events could not be read and were skipped. */
  unreadable: number;
}

/** Follow a campaign's progress events while `enabled`.
 *
 * Each event also asks for a fresh copy of the campaign (debounced, so a burst
 * is one refresh), so the page always shows the operator's authoritative state
 * and the events only say WHEN to look. The stream is aborted when the page
 * goes away or `enabled`/`restartKey` changes. */
export function useCampaignStream(id: string, enabled: boolean, restartKey: string): CampaignStream {
  const queryClient = useQueryClient();
  const [log, setLog] = useState<readonly ProgressEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [unreadable, setUnreadable] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    const refreshSoon = () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: operatorKeys.campaign(id) });
        void queryClient.invalidateQueries({ queryKey: operatorKeys.receipt(id) });
        void queryClient.invalidateQueries({ queryKey: operatorKeys.campaigns });
      }, 150);
    };

    void subscribeToEvents({
      campaignId: id,
      getToken,
      signal: controller.signal,
      onOpen: () => {
        setLog([]);
      },
      onEvent: (event) => {
        setLog((previous) => [...previous, event].slice(-LOG_LIMIT));
        refreshSoon();
      },
      onStatus: setStatus,
      onUnauthorized: rejectToken,
      onUnreadable: () => {
        setUnreadable((n) => n + 1);
      },
    });

    return () => {
      controller.abort();
      clearTimeout(refreshTimer.current);
    };
  }, [id, enabled, restartKey, queryClient]);

  return { log, status, unreadable };
}
