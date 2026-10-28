import { tool, type Plugin } from "@opencode-ai/plugin"

export const RenameSessionPlugin: Plugin = async ({ client }) => {
  const renameSession = tool({
    description:
      "Rename the current opencode session. Knows its own session ID — safe with parallel sessions.",
    args: {
      title: tool.schema.string().describe("New session title"),
    },
    async execute(args, context) {
      await client.session.update({
        path: { id: context.sessionID },
        body: { title: args.title },
      })
      return `Session renamed to: ${args.title}`
    },
  })

  return {
    tool: {
      rename_session: renameSession,
    },
  }
}