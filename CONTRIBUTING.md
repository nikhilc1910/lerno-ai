# Contributing to Lerno.ai

Thank you for your interest in contributing to Lerno.ai! This guide will help you get started.

## Development Setup

1. Fork the repository
2. Clone your fork locally
3. Install dependencies (see [README](README.md#-getting-started))
4. Create a feature branch from `main`

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`, `perf`, `ci`

**Examples:**
```bash
feat(auth): add password reset flow
fix(chat): resolve message ordering in multiplayer lobby
docs(readme): update installation instructions
refactor(backend): extract narration service into module
```

## Pull Request Process

1. Ensure your code builds without errors (`npm run build`)
2. Update documentation if you changed any APIs or configuration
3. Write a clear PR description explaining **what** and **why**
4. Link any related issues

## Code Style

- **TypeScript**: Follow the existing ESLint configuration
- **Python**: Follow PEP 8 conventions
- **CSS**: Use Tailwind utility classes; avoid inline styles

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS information
- Screenshots if applicable

## Feature Requests

Open an issue with the `enhancement` label describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered
