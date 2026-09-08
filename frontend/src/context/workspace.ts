import { createContext, useContext } from "react";
import { createWorkspaceClient, type User } from "../lib/api";

export function workspace(target: User | null, manage = false, reauthorize?: () => Promise<void>) {
  return { target, manage, client: createWorkspaceClient(target?.id, manage, reauthorize) };
}

export const WorkspaceContext = createContext<
  (ReturnType<typeof workspace> & {
    view: (user: User | null, manage?: boolean) => void;
    readOnly: boolean;
  }) | null
>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider missing");
  return value;
}
