---
name: system-admin
description: "MUST load before installing ANY system package. Provides pkg-install for Java, Python, Go, Rust, FFmpeg, databases, compilers, and all Alpine packages."
---

## pkg-install — system package manager

This environment is Alpine Linux. Use `pkg-install` to manage system packages.
`sudo` and `apk` are NOT available directly — always use `pkg-install`.

### Install

```
pkg-install <package> [package2 ...]
```

Examples:

```
pkg-install openjdk17-jdk          # install Java 17
pkg-install make cmake gcc          # install multiple packages
pkg-install nodejs=20.15.1-r0       # install a specific version
```

### Remove

```
pkg-install --remove <package> [...]
```

### Search, Info, List

```
pkg-install --search <keyword>      # search available packages
pkg-install --info <package>         # show details and available versions
pkg-install --list                   # list all installed packages
pkg-install --help                   # show full help
```

### Version pinning

To install a specific version, append `=<version>`:

```
pkg-install nodejs=20.15.1-r0
```

Use `pkg-install --info <package>` first to see available versions.

## Common package names (Alpine)

| Need                | Package name        |
|---------------------|---------------------|
| Java 17             | openjdk17-jdk       |
| Java 21             | openjdk21-jdk       |
| GCC / G++ / Make    | build-base          |
| CMake               | cmake               |
| SQLite              | sqlite              |
| PostgreSQL client   | postgresql-client   |
| MySQL / MariaDB cli | mariadb-client      |
| Redis cli           | redis               |
| FFmpeg              | ffmpeg              |
| ImageMagick         | imagemagick         |
| PHP                 | php83               |
| Ruby                | ruby                |
| Perl                | perl                |
| Lua                 | lua5.4              |
| .NET SDK            | dotnet8-sdk         |
| Nginx               | nginx               |
| Docker CLI          | docker-cli          |
| tmux                | tmux                |
| vim / neovim        | vim / neovim        |
| jq / yq            | jq / yq             |

## Pre-installed tools

The following are already available (no install needed):

- **Languages**: python3, pip, node, npm, go, rustc, cargo
- **VCS**: git
- **Network**: curl, wget, ssh, ss
- **Shell**: bash
- **Compression**: zip, unzip, gzip, bzip2, xz, tar, zstd

## Language-specific package managers

For language ecosystem packages, use the native tool directly (no pkg-install needed):

```
pip install <pkg>           # Python
npm install <pkg>           # Node.js
go install <pkg>@latest     # Go
cargo install <pkg>         # Rust
```

## Rules

- ALWAYS use `pkg-install` for system packages
- NEVER use `sudo`, `apk`, or download binaries manually
- NEVER tell the user that system packages cannot be installed — they CAN via pkg-install
- NEVER modify ~/.profile or ~/.bashrc for PATH — packages install to standard paths
- When unsure about the package name, use `pkg-install --search <keyword>` first
