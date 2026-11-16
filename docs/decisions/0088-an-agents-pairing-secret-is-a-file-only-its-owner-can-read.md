# 0088. An agent's pairing secret is a file only its owner can read

**Status:** Accepted on 2026-10-08.

## Context

`sval-mcp` must keep each agent's pairing secret between runs. The OS
credential store (Keychain on macOS, Credential Manager on Windows, Secret
Service on Linux) is rejected. On macOS that store asks the user before
`sval-mcp` reads its own item: "sval-mcp wants to use your confidential
information stored in 'sval-mcp'". The prompt cannot say why. It looks like a
program snooping for passwords. A development build of `sval-mcp` is ad-hoc
signed, so every rebuild is a new program to the Keychain, and the prompt
comes back after each one.

The store guards against nothing a private file leaves open. The threat that
matters here is another process running as the user (spec §3.6). That process
can already open the profile's owner-only `sval-agents` directory, read the
port file's token and read the whole profile, cookies included. Credential
Manager and an unlocked Secret Service hand the secret to any process of the
same user without asking. Against other OS users, a file in a 0700 directory
protects as well as the store does.

## Decision

`sval-mcp` keeps each agent's credentials in its own JSON file in
`<profile>/sval-agents/`. The file's name is a hash of the account: the
profile path, the client name, the directory the agent was launched in and its
instance there.

- On Unix the directory is 0700, created so or tightened to it, and the file
  is 0600 from the moment it exists.
- On Windows the profile directory's ACL keeps other users out, as it does for
  `port.json` and `agents.json`.
- A write goes to a fresh temporary file that is then renamed over the old
  one, so a reader sees one whole file. Forgetting a credential deletes its
  file.
- `sval-mcp` never logs the secret.

The protection that counts comes from elsewhere: pairing needs the user's
Allow in Sval, an agent acts only in its own workspace, site policy and the
write gate limit what it may do (0073), and both sides prove they can read the
port file before any secret moves (0072).

## Consequences

`sval-mcp` asks for nothing on any platform, and a rebuild changes nothing for
the user.

A copy of the profile carries the secret beside its hash. The copy already
carries the user's signed-in sessions, so the secret gives its holder nothing
more.
