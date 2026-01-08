# Publishing PR Agent MCP Server

This guide covers publishing the PR Agent MCP server to various registries and marketplaces.

## npm Registry

### Prerequisites
- npm account (create at https://www.npmjs.com/signup)
- Logged into npm CLI

### Steps

1. Login to npm:
```bash
npm login
```

2. Publish the package:
```bash
cd pr-agent-plugin
npm publish
```

3. Verify publication:
```bash
npm view pr-agent-mcp
```

### Updates

To publish updates:
1. Update version in `package.json`
2. Run `npm publish`

## Smithery MCP Marketplace

### Prerequisites
- GitHub account
- Repository with the MCP server

### Steps

1. Visit https://smithery.ai/
2. Click "Submit Server"
3. Enter repository URL: `https://github.com/techdebtgpt/pr-agent`
4. Specify subdirectory: `pr-agent-plugin`
5. The `smithery.json` configuration will be auto-detected

### Verification
Once submitted, the server will appear at:
`https://smithery.ai/server/pr-agent-mcp`

## mcp.run

### Steps

1. Visit https://mcp.run/
2. Click "Add Server"
3. Provide npm package name: `pr-agent-mcp`
4. Submit for review

## Local Installation

For local development or private use:

```bash
# Clone the repo
git clone https://github.com/techdebtgpt/pr-agent.git

# Install dependencies
cd pr-agent/pr-agent-plugin
npm install

# Add to Claude Code settings (~/.claude/settings.json)
{
  "mcpServers": {
    "pr-agent": {
      "command": "node",
      "args": ["/path/to/pr-agent/pr-agent-plugin/server/index.js"]
    }
  }
}
```

## Verification After Publishing

Test that the package works:

```bash
# Install globally
npm install -g pr-agent-mcp

# Test server starts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pr-agent-mcp

# Add to MCP settings
{
  "mcpServers": {
    "pr-agent": {
      "command": "npx",
      "args": ["pr-agent-mcp"]
    }
  }
}
```
