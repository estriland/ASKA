// Chat is not a repository-maintenance agent. Keep the explicit character prompt
// but do not discover AGENTS/CLAUDE or implicit APPEND_SYSTEM instructions.
import {FILE_GUIDE} from './file-attachments.mjs';
export function chatResourceOptions({ cwd, agentDir, systemPrompt }) {
  return { cwd, agentDir, systemPrompt:systemPrompt+FILE_GUIDE, noContextFiles: true, appendSystemPrompt: [], noExtensions: true, noSkills: true, noPromptTemplates: true };
}
