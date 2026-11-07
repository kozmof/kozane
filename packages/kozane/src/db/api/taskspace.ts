import { records } from "@kozane/core/database";
export const getAllTaskspaces: typeof records.taskspace.getAllTaskspaces =
  records.taskspace.getAllTaskspaces;
export const getTaskspacesInNamespace: typeof records.taskspace.getTaskspacesInNamespace =
  records.taskspace.getTaskspacesInNamespace;
export const getTaskspaceInNamespace: typeof records.taskspace.getTaskspaceInNamespace =
  records.taskspace.getTaskspaceInNamespace;
export const addTaskspace: typeof records.taskspace.addTaskspace = records.taskspace.addTaskspace;
export const updateTaskspace: typeof records.taskspace.updateTaskspace =
  records.taskspace.updateTaskspace;
export const getTaskspace: typeof records.taskspace.getTaskspace = records.taskspace.getTaskspace;
export const deleteTaskspace: typeof records.taskspace.deleteTaskspace =
  records.taskspace.deleteTaskspace;
