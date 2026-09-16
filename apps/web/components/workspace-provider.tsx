'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { defaultWorkspaceSettings, type WorkspaceSettings } from '@stillup/core';
const WorkspaceContext = createContext({
  settings: defaultWorkspaceSettings,
  update: (_settings: WorkspaceSettings) => {},
});
export function WorkspaceProvider({
  initial,
  children,
}: {
  initial: WorkspaceSettings;
  children: React.ReactNode;
}) {
  const [settings, update] = useState(initial);
  useEffect(() => {
    update(initial);
  }, [initial]);
  return (
    <WorkspaceContext.Provider value={{ settings, update }}>{children}</WorkspaceContext.Provider>
  );
}
export const useWorkspace = () => useContext(WorkspaceContext);
