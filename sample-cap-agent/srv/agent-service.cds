@requires: 'authenticated-user'
service AgentService {
  /** Answer a question with one AI Core call. */
  action ask(question : String) returns String;

  /** MCP-style agent: 30+ tool definitions and a multi-turn history. */
  action runAgent(question : String) returns String;
}
