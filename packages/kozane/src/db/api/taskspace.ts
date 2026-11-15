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
export const addTaskspaceInTx: typeof records.taskspace.addTaskspaceInTx =
  records.taskspace.addTaskspaceInTx;
export const updateTaskspaceName: typeof records.taskspace.updateTaskspaceName =
  records.taskspace.updateTaskspaceName;
export const updateTaskspaceNameInTx: typeof records.taskspace.updateTaskspaceNameInTx =
  records.taskspace.updateTaskspaceNameInTx;
export const updateTaskspaceLocation: typeof records.taskspace.updateTaskspaceLocation =
  records.taskspace.updateTaskspaceLocation;
export const updateTaskspaceLocationInTx: typeof records.taskspace.updateTaskspaceLocationInTx =
  records.taskspace.updateTaskspaceLocationInTx;
export const deleteTaskspaceInTx: typeof records.taskspace.deleteTaskspaceInTx =
  records.taskspace.deleteTaskspaceInTx;
