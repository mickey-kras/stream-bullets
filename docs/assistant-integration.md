# Assistant integration: capability check and decision record

Status: proposed. The owner did not approve this record.
Date of the checks: 21 November 2026. Issue: #673.

This record answers one question: how can a streamer connect StreamBullets to Claude and to ChatGPT?
It gives the facts from the current vendor documents, the options, and one recommendation.
No code exists for this feature.

## Summary

- Build one remote MCP server in the application Worker. Claude and ChatGPT use the same server.
- Use the Streamable HTTP transport without sessions. The server needs no Durable Object and no session store.
- Use the MCP plugin of `better-auth` as the OAuth 2.1 authorization server. It uses the sessions and the D1 database that the application has.
- Claude meets the full goal on all plans. A streamer adds the server by its address, without a review.
- ChatGPT meets the full goal only in Business, Enterprise and Edu workspaces. The documents give Pro users read tools only. Write tools on all other plans need a published plugin, and that needs a review by OpenAI.
- Start with read tools. Add write tools in later steps, each with its own scope.

## Facts from the vendor documents

### Claude

- Custom connectors work on the Free, Pro, Max, Team and Enterprise plans. The Free plan permits one custom connector.
- The streamer adds a connector with a name and an address. A link can fill in the two fields.
- Anthropic does not review a custom connector. The directory is optional.
- The connection comes from the cloud of Anthropic. The server must use port 443.
- The transport is Streamable HTTP. Anthropic stops the support for the older transport, HTTP with SSE.
- Authorization is OAuth with PKCE (S256) and protected resource metadata (RFC 9728).
- Claude identifies itself with a metadata document for its client ID (CIMD), or with dynamic client registration.
  It uses the CIMD only when the server metadata has `client_id_metadata_document_supported: true` and the method `none`.
  If not, it uses dynamic client registration.
- The redirect address of the hosted products is `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback address.
- Refresh tokens for public clients must rotate.
- A tool result has a limit of about 150,000 characters. A tool call has a limit of 240 seconds.
- Claude Research calls connector tools without approval for each call. Anthropic tells users to turn write tools off there.

### ChatGPT

- The name of the mechanism is Plugins. The older names (Apps SDK, connectors, developer mode) go to the Plugins documents.
- A user adds a custom MCP server by its address and makes a plugin from it.
- Custom MCP servers with write tools are for Business, Enterprise and Edu workspaces, on the web only.
  In a Business workspace, only administrators and owners make and publish them.
  The documents give Pro users read and fetch permissions only.
- A public plugin needs a submission, a review and a publication. The submission needs identity verification.
  It also needs a demonstration account with a password and without a second factor.
- Authorization is OAuth 2.1 as in the MCP specification of 25 November 2025: protected resource metadata, the `resource` parameter, and PKCE (S256).
- ChatGPT prefers a CIMD. It also supports dynamic client registration and clients with a registration from before.
- ChatGPT checks the `iss` parameter (RFC 9207).
- ChatGPT asks the user to confirm a write action. It handles a tool without `readOnlyHint` as a write tool.
- Without the `offline_access` scope, the user must sign in again when the access token ends.

### MCP specification

- The newest stable revision has the date 28 July 2026. The revision before it has the date 25 November 2025.
- The new revision has no sessions and no `initialize` step. Each call is complete.
- The MCP server is an OAuth resource server. It must give protected resource metadata.
- The specification recommends a CIMD. It permits dynamic client registration, but it does not recommend it.

### Libraries on Workers

| Library | Version | Function | Storage |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.4.0 | MCP server with a stateless handler for Workers. It can also answer clients of the older revisions. | None |
| `agents` (Cloudflare) | 0.34.0 | A handler on top of the same SDK. | None for the stateless handler |
| `@cloudflare/workers-oauth-provider` | 1.2.4 | OAuth provider that goes around the Worker. The application supplies the sign-in and consent step. | A KV namespace |
| `@better-auth/mcp` | 1.7.17 | OAuth 2.1 provider as a plugin of `better-auth`. It stores the consent, revokes tokens and rotates refresh tokens. | Tables in the database of `better-auth` |

The application uses `better-auth` 1.7.17. The plugin has a release with the same version.

## Options for the authorization server

| Topic | `@better-auth/mcp` | `@cloudflare/workers-oauth-provider` |
| --- | --- | --- |
| Sign-in | Uses the session of the application. | The application must connect its session in its own code. |
| Storage | New tables in D1, with a migration. | A new KV binding in production and in test. |
| Revocation | A user can list and delete a consent. The application can revoke tokens. | Token revocation. The list for the user is application code. |
| Risk | No stability statement in the documents. The metadata document transport in the package is for Node only. On Workers, the application must supply one. | A second identity system next to `better-auth`. |

## Decision

1. One MCP server at `/mcp` in the application Worker, with `@modelcontextprotocol/server` and its stateless handler.
   The handler also answers clients of the older revisions, because the documents do not say which revision each assistant uses.
2. `@better-auth/mcp` is the authorization server. The reason: one identity system, one database, and revocation that is available now.
3. Each tool calls the application services that the API routes use. Thus the ownership and status checks stay in one place.
4. The integration does not use the provider channel connections and does not read their tokens.
5. The MCP server has no GitHub tools. The assistant uses its own GitHub connector to create issues. The server gives public links only.
6. Live help works only in an active assistant session. The server does not watch a stream.

## Scopes and tools

| Step | Scope | Tools |
| --- | --- | --- |
| 1 | `read` | List topics, comments, polls and suggestions. Read the overlay state. |
| 2 | `discussion:write` | Publish a reply. Create a suggestion on the Ideas board with a link to the source comment. |
| 3 | `polls:write` | Create, open and close a poll. Select the topic on show. |
| 4 | `overlay:write` | Show or hide a layer. Change the layout. Restore the configuration from before the last change. |

Rules for all tools:

- Each tool has a title and the annotations `readOnlyHint`, `destructiveHint` and `openWorldHint`.
- A tool is a read tool or a write tool, not the two together. The directory of Anthropic refuses mixed tools.
- A list has a page size limit and a cursor.
- A write tool takes a key for the call. A second call with the same key makes no second post.
- Each write makes an audit record with the user, the client and the tool.
- A rate limit applies to each token.
- Text from viewers is data. The tool result marks it as text from viewers. It gives no permission to call a tool.
- A tool result has no email address, no token and no private account data.

## What each assistant can do after step 4

| Capability | Claude | ChatGPT workspace | ChatGPT Pro | ChatGPT other plans |
| --- | --- | --- | --- | --- |
| Connection without a review | Yes | Yes, an administrator adds the server | Yes | Not in the documents |
| Read tools | Yes | Yes | Yes | Only with a published plugin |
| Write tools | Yes | Yes, with a confirmation for each action | Only with a published plugin | Only with a published plugin |

The Pro column comes from one answer in the help article of OpenAI. That answer can be older than Plugins.
The prototype must check it. The documents do not say if the Free, Go and Plus plans can add a custom server.

## Decisions for the owner

1. Approve or change the decision above.
2. ChatGPT: start with workspaces only, or also prepare a public plugin.
   A public plugin needs a verification of identity. It also needs a demonstration account with a password.
   The application has sign-in with providers only, so this needs a new sign-in method for one account.
   Recommendation: workspaces only at the start.
3. Dynamic client registration: the specification deprecates it, and the plugin has it off by default.
   Recommendation: keep it off. If the check below shows that Claude needs it, turn it on.

## Checks before the build

These points are not in the documents. A short prototype in the test deployment must answer them.

- Does `@better-auth/mcp` 1.7.17 work on Workers with the D1 adapter of the application?
- Does Claude connect with a CIMD when the server supplies its own fetch transport?
- Which protocol revision does each assistant send?
- Can a ChatGPT Pro user add the server and use the read tools?
- Is there a limit on the number of tools in Claude or in ChatGPT?
- Does ChatGPT have a limit on the size or the time of a tool result?

The new packages change `package.json` and the lockfile. That change goes in a separate change and needs the approval of the owner.

## Sources

Checked on 21 November 2026.

- Claude custom connectors: <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- Claude connector building: <https://claude.com/docs/connectors/building>
- Claude connector authentication: <https://claude.com/docs/connectors/building/authentication>
- Claude review criteria: <https://claude.com/docs/connectors/building/review-criteria>
- ChatGPT help for custom servers: <https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt>
- ChatGPT plugin authorization: <https://developers.openai.com/plugins/build/auth>
- ChatGPT plugin review: <https://developers.openai.com/plugins/deploy/app-review>
- ChatGPT plugin guidelines: <https://developers.openai.com/plugins/plugin-guidelines>
- MCP authorization: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- MCP Streamable HTTP: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- Cloudflare handler: <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>
- Cloudflare OAuth provider: <https://github.com/cloudflare/workers-oauth-provider>
- `better-auth` MCP plugin: <https://better-auth.com/docs/plugins/mcp>
- `better-auth` OAuth provider plugin: <https://better-auth.com/docs/plugins/oauth-provider>
