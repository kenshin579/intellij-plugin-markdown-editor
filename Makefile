# Markora release automation
#
# Targets:
#   make help                         show this message
#   make bump-version VERSION=x.y.z   edit gradle.properties + commit + push to main
#   make tag VERSION=x.y.z            bump-version + git tag v$(VERSION) + push tag
#   make release VERSION=x.y.z        tag + gh release create v$(VERSION) --generate-notes

.PHONY: help bump-version tag release \
        check-version check-main check-clean check-tag-unique check-gh

VERSION ?=
SEMVER_REGEX := ^[0-9]+\.[0-9]+\.[0-9]+$$

help:
	@echo "Markora release automation"
	@echo ""
	@echo "Usage:"
	@echo "  make bump-version VERSION=x.y.z   # edit gradle.properties + commit + push to main"
	@echo "  make tag VERSION=x.y.z            # bump-version + git tag + push tag"
	@echo "  make release VERSION=x.y.z        # tag + gh release create"

check-version:
	@if [ -z "$(VERSION)" ]; then \
		echo "ERROR: VERSION is required (e.g. make release VERSION=0.2.0)"; exit 1; \
	fi
	@echo "$(VERSION)" | grep -Eq '$(SEMVER_REGEX)' || { \
		echo "ERROR: VERSION must match MAJOR.MINOR.PATCH (got '$(VERSION)')"; exit 1; \
	}

check-main:
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$branch" != "main" ]; then \
		echo "ERROR: must be on 'main' branch (currently on '$$branch')"; exit 1; \
	fi

check-clean:
	@git diff --quiet && git diff --cached --quiet || { \
		echo "ERROR: working tree has uncommitted changes"; exit 1; \
	}

check-tag-unique: check-version
	@if git rev-parse --verify "v$(VERSION)" >/dev/null 2>&1; then \
		echo "ERROR: tag v$(VERSION) already exists locally"; exit 1; \
	fi
	@git fetch --tags --quiet
	@if git ls-remote --exit-code --tags origin "refs/tags/v$(VERSION)" >/dev/null 2>&1; then \
		echo "ERROR: tag v$(VERSION) already exists on origin"; exit 1; \
	fi

check-gh:
	@command -v gh >/dev/null 2>&1 || { \
		echo "ERROR: gh CLI not found (install: https://cli.github.com)"; exit 1; \
	}
	@# --hostname 없이 호출하면 설정된 모든 호스트를 검사하고, 하나라도 실패하면
	@# 종료 코드가 1이 된다. 사내 GitHub Enterprise 등을 함께 등록해 둔 환경에서는
	@# 그쪽 타임아웃 때문에 github.com 인증이 멀쩡해도 릴리스가 막힌다.
	@# 릴리스가 실제로 필요한 호스트는 github.com 하나뿐이라 범위를 좁힌다.
	@gh auth status --hostname github.com >/dev/null 2>&1 || { \
		echo "ERROR: gh CLI is not authenticated for github.com (run 'gh auth login --hostname github.com')"; exit 1; \
	}

bump-version: check-version check-main check-clean
	@current=$$(grep '^pluginVersion = ' gradle.properties | sed 's/^pluginVersion = //'); \
	if [ "$$current" = "$(VERSION)" ]; then \
		echo "ERROR: pluginVersion is already $(VERSION) in gradle.properties"; exit 1; \
	fi
	@git fetch origin main --quiet
	@local_main=$$(git rev-parse main); \
	remote_main=$$(git rev-parse origin/main); \
	if [ "$$local_main" != "$$remote_main" ]; then \
		echo "ERROR: local main is not in sync with origin/main (run: git pull --ff-only)"; exit 1; \
	fi
	@# Portable in-place sed (works on both GNU and BSD sed via -i.bak)
	@sed -i.bak -E 's/^pluginVersion = .*/pluginVersion = $(VERSION)/' gradle.properties
	@rm -f gradle.properties.bak
	@grep -q '^pluginVersion = $(VERSION)$$' gradle.properties || { \
		echo "ERROR: gradle.properties update failed"; exit 1; \
	}
	@echo "Updated gradle.properties: pluginVersion = $(VERSION)"
	@git add gradle.properties
	@git commit -m "chore: bump version to $(VERSION)"
	@git push origin main
	@echo "Pushed bump commit to origin/main"

tag: check-version check-main check-clean check-tag-unique bump-version
	@git tag "v$(VERSION)"
	@git push origin "v$(VERSION)"
	@echo "Pushed tag v$(VERSION) to origin"

release: check-version check-main check-clean check-tag-unique check-gh tag
	@if gh release view "v$(VERSION)" >/dev/null 2>&1; then \
		echo "Release v$(VERSION) already exists (likely created by release.yml). Skipping gh release create."; \
	else \
		gh release create "v$(VERSION)" --title "v$(VERSION)" --generate-notes; \
		echo "Created GitHub release v$(VERSION)"; \
	fi
	@echo "GitHub release v$(VERSION) is ready (workflow will attach the plugin zip)"
