# AgentClock menu bar app.
#
# No Xcode project, no SwiftPM, no dependencies: one swiftc invocation and a
# hand-assembled bundle. `xcode-select --install` is enough — the Command Line
# Tools SDK ships AppKit.
#
#   make            build the .app
#   make install    build, then install to /Applications and launch it
#   make run        build and run in the foreground (^C to stop)
#   make uninstall  remove the app and the launch-at-login agent
#   make clean

APP      := AgentClock
BUNDLE   := build/$(APP).app
BIN      := $(BUNDLE)/Contents/MacOS/$(APP)
DEST     := /Applications/$(APP).app
LAUNCHD  := $(HOME)/Library/LaunchAgents/dev.agentclock.menubar.plist

# Match the CLI's floor rather than the build machine's OS, so the bundle runs on
# anything LSMinimumSystemVersion claims it does.
TARGET   := arm64-apple-macosx11.0
ifeq ($(shell uname -m),x86_64)
TARGET   := x86_64-apple-macosx11.0
endif

.PHONY: all install run uninstall clean check

all: $(BUNDLE)

$(BUNDLE): $(APP).swift Info.plist
	@mkdir -p $(BUNDLE)/Contents/MacOS
	swiftc -O -target $(TARGET) -o $(BIN) $(APP).swift
	@cp Info.plist $(BUNDLE)/Contents/Info.plist
	@printf 'APPL????' > $(BUNDLE)/Contents/PkgInfo
	@# Re-sign after assembling so the seal covers Info.plist, not just the binary.
	@# Ad-hoc (`-`) on purpose: code compiled on the machine that runs it is never
	@# quarantined, so there is no Gatekeeper prompt and no need for a $99 cert.
	@codesign --force --sign - $(BUNDLE)
	@echo "built $(BUNDLE) ($$(du -sh $(BUNDLE) | cut -f1))"

# Type-check only. Used by CI, which must not link or launch anything.
check:
	swiftc -typecheck -target $(TARGET) $(APP).swift

install: $(BUNDLE)
	@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	@# pkill as well: the app is LSUIElement, so `quit app` does not always reach it.
	@pkill -x $(APP) 2>/dev/null || true
	@sleep 1
	@rm -rf $(DEST)
	@cp -R $(BUNDLE) $(DEST)
	@open $(DEST)
	@echo "installed $(DEST) — look for the ◐ in your menu bar"

run: $(BUNDLE)
	@$(BIN)

uninstall:
	@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	@pkill -x $(APP) 2>/dev/null || true
	@rm -f $(LAUNCHD)
	@rm -rf $(DEST)
	@echo "removed $(DEST) and $(LAUNCHD)"

clean:
	@rm -rf build
