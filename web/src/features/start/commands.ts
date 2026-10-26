import { PROJECT_REPO_URL } from "@/lib/project";

/** The commands that run ZecDrop on your own computer, as the README gives them (REQ-RUN-002). */
export const START_COMMANDS: readonly string[] = [`git clone ${PROJECT_REPO_URL}.git`, "cd zecdrop", "./zecdrop up"];
