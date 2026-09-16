import 'server-only';
import { cache } from 'react';
import { defaultWorkspaceSettings, workspaceSettingsSchema } from '@stillup/core';
import { serverApi } from './api';

export const readWorkspace = cache(async () => {
  try {
    const response = await serverApi('public/workspace', false);
    if (!response.ok) return defaultWorkspaceSettings;
    return workspaceSettingsSchema.parse(await response.json());
  } catch {
    return defaultWorkspaceSettings;
  }
});
