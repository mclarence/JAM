import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { notify } from "@/lib/notify";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (error instanceof ApiError && error.kind === "notConnected") return;
      notify.error(error, query.meta?.errorTitle as string | undefined, String(query.queryKey[0]));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        !(error instanceof ApiError && ["unauthorized", "invalid", "notConnected", "http"].includes(error.kind)) &&
        count < 2,
    },
  },
});
