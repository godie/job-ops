import * as api from "@client/api";
import { useQuery } from "@tanstack/react-query";

/**
 * Whether the signed-in user is a system administrator. Shares the ["auth", "me"]
 * query with the rest of the settings page, so it costs no extra request.
 */
export function useIsSystemAdmin(): boolean {
  const { data } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await api.getCurrentAuthUser();
      } catch {
        // Fail soft: when the identity is unknown, treat the caller as a member
        // and withhold administrator controls rather than guessing.
        return null;
      }
    },
    retry: false,
  });
  return data?.isSystemAdmin === true;
}
