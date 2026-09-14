// AgentClock — the edge HUD.
//
// A borderless panel flush against the right edge of the screen — a tab growing
// out of the edge rather than a window floating near it, rounded on its left side
// and square where it meets the edge. At rest it is a narrow black strip: a dot per
// working session stacked vertically, a numeral for the idle ones, a ring for the
// quota scope closest to exhaustion. Point at it and it opens into a card with the
// whole readout. Click and the card stays.
//
// Everything here is presentation. The data comes in as a Snapshot that
// AgentClock.swift has already computed — this file never reads the registry, the
// transcripts or the usage cache, which is what keeps test/menubar.test.js holding
// one implementation equal to the TypeScript rather than two.
//
// Why a floating panel rather than a taller menu bar item: a status item is exactly
// as tall as the menu bar and cannot draw outside it, so "full info on hover" does
// not fit. Measured on macOS 15.7 before this was written: the panel never takes
// focus, survives a full-screen Space, and costs 0.0-0.1% CPU.

import AppKit

// MARK: - Look

/// Geometry and colour in one place, because a HUD that disagrees with itself by a
/// pixel looks broken in a way that no single number explains.
enum HUDStyle {
  /// The resting pill runs *down* the edge, not across it. Vertical is the shape
  /// the position already implies — it hugs the screen edge instead of reaching
  /// into the window underneath, and it grows downward as sessions appear rather
  /// than creeping sideways across whatever you are reading.
  static let pillMinWidth: CGFloat = 42
  static let pillPadY: CGFloat = 10
  static let pillPadX: CGFloat = 7
  static let radius: CGFloat = 22

  static let cardWidth: CGFloat = 356
  static let cardPadX: CGFloat = 13
  static let cardPadY: CGFloat = 13

  /// The border's weight. It is the only thing separating a black tab from a dark
  /// wallpaper, so it is a border rather than a hairline.
  static let border: CGFloat = 1.5

  /// The concave flare where the tab meets the screen edge.
  ///
  /// Without it the tab's top and bottom edges hit the edge of the screen at a hard
  /// right angle and the thing reads as a rectangle someone shoved off the side.
  /// The flare curves them outward into the edge instead, so it reads as growing
  /// out of it. It costs this much height at each end, which is why the panel is
  /// taller than its content.
  static let flare: CGFloat = 12

  /// Flush against the screen edge — no gap.
  ///
  /// The panel is a tab growing out of the edge rather than an object floating near
  /// it, so only its left corners are rounded and its right side runs off the side
  /// of the screen. It also makes the whole thing a Fitts's-law edge target: throw
  /// the pointer at the right edge and you cannot miss it.
  static let edgeMargin: CGFloat = 0

  static let dot: CGFloat = 8
  static let dotGap: CGFloat = 6
  static let arc: CGFloat = 18
  static let gap: CGFloat = 7
  /// Space either side of the hairline that separates the dots from the numbers.
  static let ruleGap: CGFloat = 8

  static let rowSession: CGFloat = 20
  static let rowAgent: CGFloat = 17
  static let rowQuota: CGFloat = 19
  static let rowLabel: CGFloat = 18
  static let rowSeparator: CGFloat = 11

  /// Dots for working sessions stop at eight and become "+N". Past that the row is
  /// a texture rather than a count, and a count is the entire point.
  static let maxDots = 8

  static var head: NSFont { .systemFont(ofSize: 12.5, weight: .semibold) }
  static var body: NSFont { .systemFont(ofSize: 11.5, weight: .regular) }
  static var num: NSFont { .monospacedDigitSystemFont(ofSize: 11, weight: .regular) }
  static var small: NSFont { .systemFont(ofSize: 10, weight: .medium) }
  static var caps: NSFont { .systemFont(ofSize: 9.5, weight: .semibold) }

  /// The resting pill is read at a glance from across a desk, and it is the only
  /// thing on screen the whole time — so its type is a size up from the card's.
  /// The card is read deliberately, with the pointer already on it, and can stay
  /// small.
  static var pillNum: NSFont { .monospacedDigitSystemFont(ofSize: 14, weight: .medium) }
  static var pillQuota: NSFont { .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium) }
  static var pillSmall: NSFont { .systemFont(ofSize: 11, weight: .semibold) }

  /// Ink, not `labelColor`.
  ///
  /// The panel is pinned to a dark vibrant appearance, so the semantic label
  /// colours are the wrong tool twice over: they follow the *system* theme rather
  /// than this panel's, and they are tuned for solid backgrounds — on a translucent
  /// HUD material `secondaryLabelColor` and below wash out to unreadable. Measured
  /// by looking at it: the first draft's elapsed times were invisible.
  static let ink = NSColor.white.withAlphaComponent(0.95)
  static let ink2 = NSColor.white.withAlphaComponent(0.66)
  static let ink3 = NSColor.white.withAlphaComponent(0.44)
  static let ink4 = NSColor.white.withAlphaComponent(0.27)
  static let rule = NSColor.white.withAlphaComponent(0.12)
  static let track = NSColor.white.withAlphaComponent(0.11)

  /// Teal for working, amber for waiting, grey for idle — the same language
  /// src/render/term.ts speaks, so the terminal and the HUD never disagree about
  /// what a colour means.
  static var working: NSColor { .systemTeal }
  static var waiting: NSColor { .systemOrange }

  /// Fixed columns, measured from the right edge. Laying these out relative to the
  /// previous column left the numbers ragged down the card whenever a project name
  /// or a reset time changed width; a column that moves is a column you re-read.
  static let colTokens: CGFloat = 50
  static let colElapsed: CGFloat = 46
  static let colProject: CGFloat = 88
  static let colReset: CGFloat = 52
  static let colMeter: CGFloat = 64
  static let colPercent: CGFloat = 42
  static let colGap: CGFloat = 9

  /// Coloured by what is left, not by what is used, with the blunt thresholds from
  /// quotaStyle() in term.ts: a quarter left is worth noticing, a tenth is worth
  /// interrupting for.
  static func quota(_ left: Int) -> NSColor {
    if left <= 10 { return .systemRed }
    if left <= 25 { return .systemOrange }
    return .systemTeal
  }
}

/// The pill's content as a line of text.
///
/// The pill is drawn, not typeset, so this renders the same state as a string —
/// it exists so test/menubar.test.js can assert on the HUD the way it already
/// asserts on `--badge`, without a screenshot. Mirrors `HUDView.pillItems()`;
/// change one and change the other.
func hudSummary(_ s: Snapshot) -> String {
  var parts: [String] = []
  if !s.waiting.isEmpty { parts.append("◑ \(s.waiting.count) waiting") }

  let working = s.working
  if working.isEmpty, s.waiting.isEmpty {
    parts.append("◌")
  } else if !working.isEmpty {
    let dots = working.map { s.coolingIds.contains($0.sessionId) ? "◐" : "●" }
    let shown = dots.prefix(HUDStyle.maxDots).joined()
    parts.append(
      dots.count > HUDStyle.maxDots ? "\(shown)+\(dots.count - HUDStyle.maxDots)" : shown)
  }

  if !s.idle.isEmpty { parts.append("\(s.idle.count)") }
  if let left = s.sessionQuota?.left { parts.append("\(left)%") }
  return parts.joined(separator: " ")
}

// MARK: - Timing

/// Dwell before expanding. Short enough to feel like a reflex, long enough that
/// crossing the pill on the way somewhere else does not open it.
private let HOVER_DWELL: TimeInterval = 0.12

/// Grace before collapsing, so the pointer can leave and come back.
private let HOVER_GRACE: TimeInterval = 0.35

/// Slack around the frame before the safety poll decides the pointer really has
/// left. The same idea as the badge's hold window, at a much smaller scale.
private let EXIT_HYSTERESIS: CGFloat = 16

/// How often to check whether the pointer is still here.
///
/// Not redundant with the tracking area: mouseExited is unreliable at high cursor
/// velocity and leaves the card stuck open. Shipped apps hit this and fall back to
/// polling; this is the same fallback, cheap because it is a point-in-rect test.
private let EXIT_POLL: TimeInterval = 0.5

private let EXPAND_DURATION: TimeInterval = 0.19
private let FADE_DURATION: TimeInterval = 0.13

/// Opacity when nothing is working. The hedge against an always-visible element:
/// with nothing running it is nearly gone, without ever losing the glance.
private let RESTING_ALPHA: CGFloat = 0.42

// MARK: - What the HUD needs from the app

protocol HUDDelegate: AnyObject {
  /// The menu for a right-click, or the ⋯ button.
  func hudContextMenu() -> NSMenu
  func hudOpenDashboard()
  func hudReveal(_ cwd: String)
}

// MARK: - Panel

/// Never key, never main, never activating.
///
/// Both halves are load-bearing and neither is sufficient: `.nonactivatingPanel`
/// stops the *app* becoming frontmost, `canBecomeKey` stops the *window* taking
/// focus. Miss either and clicking the HUD over a full-screen app can throw the
/// user back to the desktop Space.
final class HUDPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// Draws the tab's silhouette: convex on the left, flared into the screen edge on
/// the right.
///
/// A drawn path rather than a layer corner radius, because `CALayer` can only round
/// corners inward — there is no way to ask it for the concave flare, and no way to
/// leave one side unstroked. Doing it by hand buys both.
final class TabBackdrop: NSView {
  override var isFlipped: Bool { false }

  /// Fill and stroke are separate paths on purpose: the fill closes across the
  /// screen edge, the stroke stops short of it. The tab is attached to that edge,
  /// and an edge it is attached to is not an edge it should be outlined against.
  private func outline(closed: Bool) -> NSBezierPath {
    let w = bounds.width, h = bounds.height
    let f = min(HUDStyle.flare, h / 2)
    let r = min(HUDStyle.radius, (h - f * 2) / 2, w / 2)
    let path = NSBezierPath()

    if closed {
      path.move(to: NSPoint(x: w, y: 0))
      path.line(to: NSPoint(x: w, y: h))
    } else {
      path.move(to: NSPoint(x: w, y: h))
    }
    // Top flare: leaves the screen edge vertical, arrives on the top edge level.
    path.appendArc(
      withCenter: NSPoint(x: w - f, y: h), radius: f,
      startAngle: 0, endAngle: 270, clockwise: true)
    path.line(to: NSPoint(x: r, y: h - f))
    path.appendArc(
      withCenter: NSPoint(x: r, y: h - f - r), radius: r,
      startAngle: 90, endAngle: 180, clockwise: false)
    path.line(to: NSPoint(x: 0, y: f + r))
    path.appendArc(
      withCenter: NSPoint(x: r, y: f + r), radius: r,
      startAngle: 180, endAngle: 270, clockwise: false)
    path.line(to: NSPoint(x: w - f, y: f))
    // Bottom flare, the mirror of the top.
    path.appendArc(
      withCenter: NSPoint(x: w - f, y: 0), radius: f,
      startAngle: 90, endAngle: 0, clockwise: true)
    if closed { path.close() }
    return path
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.black.setFill()
    outline(closed: true).fill()

    let stroke = outline(closed: false)
    stroke.lineWidth = HUDStyle.border
    // Half the stroke would otherwise fall outside the fill and go soft against the
    // wallpaper; clipping to the silhouette keeps the inner half only, which is the
    // crisp one.
    NSGraphicsContext.saveGraphicsState()
    outline(closed: true).addClip()
    NSColor.white.withAlphaComponent(0.34).setStroke()
    stroke.stroke()
    NSGraphicsContext.restoreGraphicsState()
  }

  /// The shape changes with every frame of the expand animation, so it has to be
  /// redrawn as it resizes rather than scaled.
  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    needsDisplay = true
  }
}

// MARK: - Controller

final class HUDController: NSObject {
  private let panel: HUDPanel
  /// A plain layer-backed view, not an NSVisualEffectView: the background is
  /// solid black, so there is nothing for a blur to blur. It also drops the
  /// `state = .active` trap and the cost of compositing live blur under a panel
  /// that is on screen from login to shutdown.
  private let chrome = TabBackdrop()
  private let view: HUDView
  weak var delegate: HUDDelegate?

  private var expanded = false
  private var pinned = false
  private var hovering = false
  private var expandWork: DispatchWorkItem?
  private var collapseWork: DispatchWorkItem?
  private var exitTimer: Timer?
  private var outsideClickMonitor: Any?
  private var screenDebounce: DispatchWorkItem?

  /// Where the pill sits on the right edge, as a fraction of the usable height.
  /// Persisted so it stays where it was put.
  private var offset: CGFloat {
    get {
      let v = UserDefaults.standard.object(forKey: "hudOffset") as? Double
      return CGFloat(min(1, max(0, v ?? 0.5)))
    }
    set { UserDefaults.standard.set(Double(newValue), forKey: "hudOffset") }
  }

  override init() {
    panel = HUDPanel(
      contentRect: NSRect(x: 0, y: 0, width: HUDStyle.pillMinWidth, height: 120),
      // .nonactivatingPanel has to be passed here: it is backed by a WindowServer
      // tag set during panel init, so mutating styleMask later leaves AppKit and
      // WindowServer disagreeing about what this window is.
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    view = HUDView()
    super.init()

    panel.isFloatingPanel = true
    // .statusBar (25) clears the Dock (20) and the menu bar (24) but stays under
    // pop-up menus (101), so system menus still win.
    panel.level = .statusBar
    panel.collectionBehavior = [
      .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
    ]
    // NSPanel defaults this to true, unlike NSWindow. Left alone, the HUD would
    // vanish every time another app came forward — which is always.
    panel.hidesOnDeactivate = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovable = false  // so Sequoia's drag-to-edge tiling cannot grab it
    panel.animationBehavior = .none
    panel.isReleasedWhenClosed = false
    // Always dark, in both system themes, so the ink palette below resolves the
    // same way everywhere. A HUD that changes polarity with the theme has to be
    // legible over every wallpaper in two directions at once.
    panel.appearance = NSAppearance(named: .vibrantDark)

    chrome.autoresizingMask = [.width, .height]

    // The content view covers the whole panel, flares included, so hover and clicks
    // cover the whole silhouette. Its drawing insets itself by the flare instead.
    view.autoresizingMask = [.width, .height]
    view.controller = self
    chrome.addSubview(view)
    panel.contentView = chrome
    view.frame = chrome.bounds

    place(animated: false)
    panel.orderFrontRegardless()
    view.needsDisplay = true

    NotificationCenter.default.addObserver(
      self, selector: #selector(screensChanged),
      name: NSApplication.didChangeScreenParametersNotification, object: nil)
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(woke),
      name: NSWorkspace.didWakeNotification, object: nil)
  }

  deinit { teardown() }

  func teardown() {
    exitTimer?.invalidate()
    exitTimer = nil
    if let m = outsideClickMonitor { NSEvent.removeMonitor(m) }
    outsideClickMonitor = nil
    NotificationCenter.default.removeObserver(self)
    NSWorkspace.shared.notificationCenter.removeObserver(self)
    panel.orderOut(nil)
  }

  // MARK: Data in

  func update(_ snapshot: Snapshot) {
    let wasSize = view.pillSize
    view.snapshot = snapshot
    view.needsDisplay = true
    // Only re-place when the pill's size actually changed. Resizing the window on
    // every tick is both ugly and wasteful; the badge guards its title assignment
    // for the same reason.
    if !expanded, view.pillSize != wasSize { place(animated: true) }
    refreshAlpha()
  }

  private func refreshAlpha() {
    let awake = hovering || pinned || view.snapshot.hasAttention
    let target: CGFloat = awake ? 1 : RESTING_ALPHA
    guard abs(panel.alphaValue - target) > 0.01 else { return }
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.45
      panel.animator().alphaValue = target
    }
  }

  // MARK: Placement

  /// Right edge, at the stored vertical offset, clamped to the usable area.
  ///
  /// visibleFrame rather than frame throughout: frame includes the menu bar and the
  /// Dock, and the one shipping app with a permanent edge strip gets this wrong and
  /// sits on top of a right-hand Dock.
  private func place(animated: Bool) {
    guard let vf = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
    let content = expanded ? view.cardSize : view.pillSize
    let size = NSSize(width: content.width, height: content.height + HUDStyle.flare * 2)
    // visibleFrame, never frame: that is what clears a right-hand Dock.
    let x = vf.maxX - size.width - HUDStyle.edgeMargin
    // Keep clear of the top and bottom corners: the bottom-right hot corner is
    // Quick Note by default, and an element that fights a hot corner feels broken.
    let lo = vf.minY + 50
    let hi = vf.maxY - 50 - size.height
    let span = max(0, hi - lo)
    let y = min(hi, max(lo, lo + span * (1 - offset)))
    let frame = NSRect(x: x, y: y, width: size.width, height: size.height)

    guard animated, !reduceMotion else {
      panel.setFrame(frame, display: true)
      panel.invalidateShadow()
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = EXPAND_DURATION
      ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().setFrame(frame, display: true)
    }, completionHandler: { [weak self] in self?.panel.invalidateShadow() })
  }

  private var reduceMotion: Bool {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  @objc private func screensChanged() {
    // Screen-parameter notifications arrive in storms — hundreds of them for one
    // ghost display. Coalesce, or the panel spends the reconfiguration jumping.
    screenDebounce?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.place(animated: false) }
    screenDebounce = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: w)
  }

  @objc private func woke() {
    // Level and collectionBehavior are re-asserted rather than trusted: some AppKit
    // paths quietly reset them, and a HUD that has silently dropped to the normal
    // window level looks like a bug in everything else.
    panel.level = .statusBar
    panel.collectionBehavior = [
      .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
    ]
    panel.orderFrontRegardless()
    place(animated: false)
  }

  // MARK: Hover

  func pointerEntered() {
    hovering = true
    collapseWork?.cancel()
    refreshAlpha()
    guard !expanded else { return }
    let w = DispatchWorkItem { [weak self] in self?.setExpanded(true) }
    expandWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + HOVER_DWELL, execute: w)
  }

  func pointerExited() {
    hovering = false
    expandWork?.cancel()
    guard expanded, !pinned else {
      refreshAlpha()
      return
    }
    let w = DispatchWorkItem { [weak self] in
      guard let self, !self.pinned, !self.pointerInside(slack: 0) else { return }
      self.setExpanded(false)
    }
    collapseWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + HOVER_GRACE, execute: w)
  }

  private func pointerInside(slack: CGFloat) -> Bool {
    panel.frame.insetBy(dx: -slack, dy: -slack).contains(NSEvent.mouseLocation)
  }

  private func setExpanded(_ on: Bool) {
    guard expanded != on else { return }
    expanded = on
    view.expanded = on
    if !on { pinned = false }
    place(animated: true)

    // Cross-fade the contents while the container animates its own shape. The
    // container is the visual constant, which is what makes this read as one
    // object changing size rather than two views swapping.
    if reduceMotion {
      view.alphaValue = 1
      view.needsDisplay = true
    } else {
      view.alphaValue = 0
      view.needsDisplay = true
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = FADE_DURATION
        view.animator().alphaValue = 1
      }
    }

    if on {
      exitTimer?.invalidate()
      exitTimer = Timer.scheduledTimer(withTimeInterval: EXIT_POLL, repeats: true) {
        [weak self] _ in
        guard let self, self.expanded, !self.pinned else { return }
        if !self.pointerInside(slack: EXIT_HYSTERESIS) { self.setExpanded(false) }
      }
    } else {
      exitTimer?.invalidate()
      exitTimer = nil
    }
    refreshAlpha()
  }

  /// The pointer can be sitting still over the pill when it appears or changes
  /// width, and mouseEntered only fires on a boundary crossing — so ask.
  func seedHover() {
    if pointerInside(slack: 0), !hovering { pointerEntered() }
  }

  // MARK: Interaction

  func togglePinned() {
    if !expanded {
      expandWork?.cancel()
      setExpanded(true)
      pinned = true
      installOutsideClickMonitor()
      return
    }
    pinned.toggle()
    if pinned {
      installOutsideClickMonitor()
    } else {
      removeOutsideClickMonitor()
      if !pointerInside(slack: 0) { setExpanded(false) }
    }
  }

  /// Mouse-only, so it needs no Accessibility grant — which matters more here than
  /// anywhere: this app is ad-hoc signed and recompiled on the user's machine, so
  /// every upgrade is a new identity and any TCC grant would have to be re-approved.
  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown]
    ) { [weak self] _ in
      guard let self, self.pinned, !self.pointerInside(slack: 0) else { return }
      self.pinned = false
      self.removeOutsideClickMonitor()
      self.setExpanded(false)
    }
  }

  private func removeOutsideClickMonitor() {
    if let m = outsideClickMonitor { NSEvent.removeMonitor(m) }
    outsideClickMonitor = nil
  }

  func showMenu(at point: NSPoint) {
    guard let menu = delegate?.hudContextMenu() else { return }
    menu.popUp(positioning: nil, at: point, in: view)
  }

  func openDashboard() { delegate?.hudOpenDashboard() }
  func reveal(_ cwd: String) { delegate?.hudReveal(cwd) }

  /// Drag along the right edge. Horizontal movement is ignored on purpose: the
  /// whole design is anchored to the edge, and a HUD floating in open space is a
  /// different thing than the one that was asked for.
  func drag(to location: NSPoint) {
    guard let vf = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
    let content = expanded ? view.cardSize : view.pillSize
    let size = NSSize(width: content.width, height: content.height + HUDStyle.flare * 2)
    let lo = vf.minY + 50
    let hi = vf.maxY - 50 - size.height
    let span = max(1, hi - lo)
    let y = min(hi, max(lo, location.y - size.height / 2))
    offset = 1 - (y - lo) / span
    panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: y))
  }
}

// MARK: - The view

/// Draws both states. One view rather than two because the panel's shape is the
/// thing the eye tracks through the transition; swapping view hierarchies under it
/// produces a flicker that no amount of animation hides.
final class HUDView: NSView {
  weak var controller: HUDController?
  var snapshot = Snapshot()
  var expanded = false

  private var rowHits: [(NSRect, String)] = []
  private var dashboardHit = NSRect.zero
  private var menuHit = NSRect.zero
  private var dragOrigin: NSPoint?
  private var dragged = false

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { false }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    // .activeAlways is what makes hover work at all: without it the tracking area
    // is inert whenever another app is frontmost, which for an agent app is always.
    addTrackingArea(
      NSTrackingArea(
        rect: bounds,
        options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
        owner: self, userInfo: nil))
    controller?.seedHover()
  }

  override func mouseEntered(with event: NSEvent) { controller?.pointerEntered() }
  override func mouseExited(with event: NSEvent) { controller?.pointerExited() }

  override func mouseDown(with event: NSEvent) {
    dragOrigin = NSEvent.mouseLocation
    dragged = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let origin = dragOrigin else { return }
    let now = NSEvent.mouseLocation
    if !dragged, abs(now.y - origin.y) < 3, abs(now.x - origin.x) < 3 { return }
    dragged = true
    controller?.drag(to: now)
  }

  override func mouseUp(with event: NSEvent) {
    defer { dragOrigin = nil }
    guard !dragged else { return }
    let p = convert(event.locationInWindow, from: nil)
    if expanded {
      if menuHit.contains(p) {
        controller?.showMenu(at: p)
        return
      }
      if dashboardHit.contains(p) {
        controller?.openDashboard()
        return
      }
      if let hit = rowHits.first(where: { $0.0.contains(p) }) {
        controller?.reveal(hit.1)
        return
      }
    }
    controller?.togglePinned()
  }

  override func rightMouseDown(with event: NSEvent) {
    controller?.showMenu(at: convert(event.locationInWindow, from: nil))
  }

  // MARK: Sizing

  /// The resting pill's size. Width follows its widest line so "100%" never
  /// clips; height is whatever the stack comes to.
  var pillSize: NSSize {
    let items = pillItems()
    let width = items.reduce(HUDStyle.pillMinWidth) {
      max($0, self.width(of: $1) + HUDStyle.pillPadX * 2)
    }
    let height = items.reduce(0) { $0 + self.height(of: $1) } + HUDStyle.pillPadY * 2
    return NSSize(width: width, height: height)
  }

  var cardSize: NSSize {
    NSSize(
      width: HUDStyle.cardWidth,
      height: cardRows().reduce(0) { $0 + height(of: $1) } + HUDStyle.cardPadY * 2)
  }

  /// How tall the card is allowed to get: the usable screen minus the same 50 pt of
  /// corner clearance `place()` keeps at each end.
  ///
  /// Without this the card simply grows — eighteen working sessions with agents
  /// under them runs off the bottom of the screen, and `place()` has no way to put
  /// a window taller than the screen anywhere sensible.
  private var heightBudget: CGFloat {
    let usable = (window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
    return usable - 100 - HUDStyle.cardPadY * 2 - HUDStyle.flare * 2
  }

  // MARK: Drawing

  override func draw(_ dirtyRect: NSRect) {
    rowHits.removeAll(keepingCapacity: true)
    dashboardHit = .zero
    menuHit = .zero
    if expanded { drawCard() } else { drawPill() }
  }

  // MARK: The pill

  /// The pill's stack, top to bottom.
  private enum PillItem {
    /// Stacked markers, one per session. `nil` draws the waiting ring.
    case dots([NSColor?])
    case text(String, NSFont, NSColor)
    case arc(Int)
    case rule
    case gap(CGFloat)
  }

  private func pillItems() -> [PillItem] {
    var items: [PillItem] = []
    let s = snapshot

    // Waiting leads, and its marker is a ring rather than a disc: a filled dot in
    // another colour reads as "one more of those", and waiting is a different kind
    // of thing — it is the one that wants you.
    if !s.waiting.isEmpty {
      items.append(.dots(Array(repeating: nil, count: min(HUDStyle.maxDots, s.waiting.count))))
      items.append(.gap(HUDStyle.gap))
    }

    let counted = s.working
    if counted.isEmpty, s.waiting.isEmpty {
      items.append(.dots([HUDStyle.ink4]))
    } else if !counted.isEmpty {
      let shown = min(HUDStyle.maxDots, counted.count)
      let colors: [NSColor?] = counted.prefix(shown).map {
        s.coolingIds.contains($0.sessionId)
          ? HUDStyle.working.withAlphaComponent(0.36) : HUDStyle.working
      }
      items.append(.dots(colors))
      if counted.count > shown {
        items.append(.gap(5))
        items.append(.text("+\(counted.count - shown)", HUDStyle.pillSmall, HUDStyle.ink2))
      }
    }

    if !s.idle.isEmpty {
      items.append(.rule)
      items.append(.text("\(s.idle.count)", HUDStyle.pillNum, HUDStyle.ink3))
    }

    // The session limit, not the binding one — see Snapshot.sessionQuota.
    if let left = s.sessionQuota?.left {
      items.append(.rule)
      items.append(.arc(left))
      items.append(.gap(4))
      items.append(.text("\(left)%", HUDStyle.pillQuota, HUDStyle.ink2))
    }

    return items
  }

  private func width(of item: PillItem) -> CGFloat {
    switch item {
    case .dots: return HUDStyle.dot
    case .text(let s, let f, _): return measure(s, f)
    case .arc: return HUDStyle.arc
    case .rule: return 0
    case .gap: return 0
    }
  }

  private func height(of item: PillItem) -> CGFloat {
    switch item {
    case .dots(let markers):
      guard !markers.isEmpty else { return 0 }
      return CGFloat(markers.count) * HUDStyle.dot
        + CGFloat(markers.count - 1) * HUDStyle.dotGap
    case .text(_, let f, _): return ceil(f.ascender - f.descender)
    case .arc: return HUDStyle.arc
    case .rule: return HUDStyle.ruleGap * 2 + 1
    case .gap(let g): return g
    }
  }

  private func drawPill() {
    let mid = bounds.midX
    var y = HUDStyle.flare + HUDStyle.pillPadY

    for item in pillItems() {
      switch item {
      case .dots(let markers):
        for marker in markers {
          let r = NSRect(
            x: mid - HUDStyle.dot / 2, y: y, width: HUDStyle.dot, height: HUDStyle.dot)
          if let marker {
            disc(r, marker)
          } else {
            ring(r.insetBy(dx: -0.5, dy: -0.5), HUDStyle.waiting, 1.5)
          }
          y += HUDStyle.dot + HUDStyle.dotGap
        }
        if !markers.isEmpty { y -= HUDStyle.dotGap }

      case .text(let text, let font, let color):
        let w = measure(text, font)
        _ = draw(text, font, color, at: NSPoint(x: mid - w / 2, y: y))
        y += height(of: item)

      case .arc(let left):
        quotaRing(
          NSRect(x: mid - HUDStyle.arc / 2, y: y, width: HUDStyle.arc, height: HUDStyle.arc), left)
        y += HUDStyle.arc

      case .rule:
        HUDStyle.rule.setFill()
        let inset = HUDStyle.pillPadX + 2
        NSRect(x: inset, y: y + HUDStyle.ruleGap, width: bounds.width - inset * 2, height: 1).fill()
        y += height(of: item)

      case .gap(let g):
        y += g
      }
    }
  }

  // MARK: The card

  private enum CardRow {
    case header(String, String?)
    case quota(String, Int, String?)
    case stale(String)
    case label(String, NSColor)
    case session(LiveSession, Bool, Int)
    case agent(String, String)
    case waiting(LiveSession)
    case separator
    case footer
    case empty(String)
  }

  private func height(of row: CardRow) -> CGFloat {
    switch row {
    case .header: return 22
    case .quota: return HUDStyle.rowQuota
    case .stale: return 15
    case .label: return HUDStyle.rowLabel
    case .session, .waiting: return HUDStyle.rowSession
    case .agent: return HUDStyle.rowAgent
    case .separator: return HUDStyle.rowSeparator
    case .footer: return 26
    case .empty: return 22
    }
  }

  private func cardRows() -> [CardRow] {
    var rows: [CardRow] = []
    let s = snapshot
    let now = Date().timeIntervalSince1970 * 1000

    guard !s.sessions.isEmpty else {
      rows.append(.empty("No Claude Code sessions are running"))
      rows.append(contentsOf: quotaRows(s, now))
      rows.append(.separator)
      rows.append(.footer)
      return rows
    }

    // Waiting leads. It is the only block here that is asking for something.
    if !s.waiting.isEmpty {
      rows.append(
        .label(
          s.waiting.count == 1 ? "waiting on you" : "\(s.waiting.count) waiting on you",
          HUDStyle.waiting))
      for session in s.waiting { rows.append(.waiting(session)) }
      rows.append(.separator)
    }

    let fan = s.fanOut
    // Idle rides on the header rather than getting a band of its own. It is a
    // number you want available, not a section you want to read.
    rows.append(
      .header(
        fan > 0
          ? "\(s.working.count) working · \(fan) \(fan == 1 ? "agent" : "agents")"
          : "\(s.working.count) working",
        s.idle.isEmpty ? nil : "\(s.idle.count) idle"))

    // Sessions are added only while they fit, keeping room for the tail. Truncating
    // the *oldest-first* list from the end means what gets dropped is the most
    // recently started work, and the count says how much.
    let tail = height(of: .separator) + height(of: .footer) + height(of: .label("", .white))
    var used = rows.reduce(0) { $0 + height(of: $1) } + height(of: .header("", nil))
    var shown = 0
    for session in s.working {
      var block: [CardRow] = [
        .session(session, s.coolingIds.contains(session.sessionId),
          s.usage.burn[session.sessionId]?.output ?? 0)
      ]
      // Type and elapsed time only — an agent's prompt is the user's own work.
      for a in (s.subagents[session.sessionId] ?? []).filter(\.running) {
        let since = a.startedAt ?? a.lastWriteAt
        block.append(.agent(a.agentType ?? "agent", duration(now - since)))
      }
      let cost = block.reduce(0) { $0 + height(of: $1) }
      // Always show at least one, even on a screen too short for it: a card that
      // lists nothing is worse than a card that overflows by a row.
      if shown > 0, used + cost + tail > heightBudget { break }
      rows.append(contentsOf: block)
      used += cost
      shown += 1
    }
    if shown < s.working.count {
      rows.append(.label("+\(s.working.count - shown) more working", HUDStyle.ink3))
    }

    rows.append(contentsOf: quotaRows(s, now))
    rows.append(.separator)
    rows.append(.footer)
    return rows
  }

  /// The quota block, at the foot of the card.
  ///
  /// Bottom rather than top because that is where the resting tab puts it: the tab
  /// reads dots, then idle, then quota, and the card it opens into should not
  /// reorder the same three facts.
  ///
  /// Only the two limits worth watching. The endpoint reports scopes agentclock has
  /// no name for — the CLI shows those under their own key, deliberately, so a new
  /// limit cannot go missing — but on a panel this small an unnamed scope sitting at
  /// 100% is noise. The binding scope is always included even when it is neither of
  /// the two, because the percentage on the tab follows it, and a number the list
  /// cannot account for is worse than a row you did not want.
  private func quotaRows(_ s: Snapshot, _ now: Double) -> [CardRow] {
    guard let quota = s.usage.quota else { return [] }
    let shown = quota.scopes.filter {
      $0.key == "five_hour" || $0.key == "seven_day" || $0.key == quota.binding?.key
    }
    guard !shown.isEmpty else { return [] }

    var rows: [CardRow] = [.separator]
    for scope in shown {
      let reset = scope.resetsAt.flatMap { $0 > now ? duration($0 - now) : nil }
      rows.append(.quota(scope.label, scope.left, reset))
    }
    // An old number must never pass for a current one.
    if quota.fetchedAt > 0, now - quota.fetchedAt > QUOTA_REFRESH_SECONDS * 4000 {
      rows.append(.stale("measured \(duration(now - quota.fetchedAt)) ago"))
    }
    return rows
  }

  private func drawCard() {
    let now = Date().timeIntervalSince1970 * 1000
    let left = HUDStyle.cardPadX
    let right = bounds.maxX - HUDStyle.cardPadX
    var y = HUDStyle.flare + HUDStyle.cardPadY

    for row in cardRows() {
      let h = height(of: row)
      switch row {
      case .header(let text, let trailing):
        _ = draw(text, HUDStyle.head, HUDStyle.ink, at: NSPoint(x: left, y: y + 3))
        if let trailing {
          _ = drawRight(trailing, HUDStyle.body, HUDStyle.ink3, rightEdge: right, y: y + 4)
        }

      case .quota(let label, let quotaLeft, let reset):
        let baseline = y + 3
        // Fixed columns, right to left: reset, percentage, meter, then the label in
        // whatever is left. Every quota row lines up down the card.
        if let reset {
          _ = drawRight(reset, HUDStyle.num, HUDStyle.ink3, rightEdge: right, y: baseline)
        }
        let pctRight = right - HUDStyle.colReset
        _ = drawRight(
          "\(quotaLeft)%", HUDStyle.num, HUDStyle.quota(quotaLeft), rightEdge: pctRight,
          y: baseline)
        let meterRight = pctRight - HUDStyle.colPercent
        meter(
          NSRect(
            x: meterRight - HUDStyle.colMeter, y: y + 7.5, width: HUDStyle.colMeter, height: 3.5),
          quotaLeft)
        _ = draw(
          label, HUDStyle.body, HUDStyle.ink2, at: NSPoint(x: left, y: baseline),
          maxWidth: meterRight - HUDStyle.colMeter - HUDStyle.colGap - left)

      case .stale(let text):
        _ = draw(text, HUDStyle.small, HUDStyle.ink3, at: NSPoint(x: left, y: y))

      case .label(let text, let color):
        _ = draw(
          text.uppercased(), HUDStyle.caps, color, at: NSPoint(x: left, y: y + 5),
          tracking: 0.9)

      case .session(let session, let cooling, let tokens):
        let color = cooling ? HUDStyle.working.withAlphaComponent(0.38) : HUDStyle.working
        drawSessionRow(
          session, y: y, height: h, marker: { r in self.disc(r, color) },
          trailing: tokens > 0 ? tokenCount(tokens) : nil, dim: cooling, now: now,
          showElapsed: true)

      case .waiting(let session):
        drawSessionRow(
          session, y: y, height: h,
          marker: { r in self.ring(r.insetBy(dx: -0.5, dy: -0.5), HUDStyle.waiting, 1.5) },
          trailing: session.waitingFor, dim: false, now: now, showElapsed: false)

      case .agent(let type, let elapsed):
        _ = draw("└", HUDStyle.num, HUDStyle.ink4, at: NSPoint(x: left + 11, y: y + 1))
        _ = drawRight(
          elapsed, HUDStyle.num.withSize(10), HUDStyle.ink4, rightEdge: right, y: y + 1)
        _ = draw(
          type, HUDStyle.body.withSize(10.5), HUDStyle.ink3, at: NSPoint(x: left + 24, y: y + 1),
          maxWidth: right - HUDStyle.colElapsed - left - 24)

      case .separator:
        HUDStyle.rule.setFill()
        NSRect(x: left, y: y + h / 2, width: bounds.width - left * 2, height: 1).fill()

      case .empty(let text):
        _ = draw(text, HUDStyle.body, HUDStyle.ink2, at: NSPoint(x: left, y: y + 3))

      case .footer:
        let label = "Open dashboard"
        let w = measure(label, HUDStyle.body)
        _ = draw(label, HUDStyle.body, HUDStyle.ink2, at: NSPoint(x: left, y: y + 4))
        dashboardHit = NSRect(x: left - 5, y: y, width: w + 10, height: h)
        let dots = "⋯"
        let dw = measure(dots, HUDStyle.head)
        _ = draw(dots, HUDStyle.head, HUDStyle.ink2, at: NSPoint(x: right - dw, y: y + 1))
        menuHit = NSRect(x: right - dw - 9, y: y, width: dw + 14, height: h)
      }
      y += h
    }
  }

  /// One session line: marker, label, project, and up to two trailing columns.
  ///
  /// Laid out from the right so the numbers line up down the card no matter how
  /// long a project name is; the label is what gets truncated, because it is the
  /// one thing you can still recognise from half of it.
  private func drawSessionRow(
    _ session: LiveSession, y: CGFloat, height h: CGFloat,
    marker: (NSRect) -> Void, trailing: String?, dim: Bool, now: Double, showElapsed: Bool
  ) {
    let left = HUDStyle.cardPadX
    let right = bounds.maxX - HUDStyle.cardPadX
    let baseline = y + 3
    let ink = dim ? HUDStyle.ink2 : HUDStyle.ink

    marker(NSRect(x: left, y: y + h / 2 - HUDStyle.dot / 2, width: HUDStyle.dot, height: HUDStyle.dot))

    // Right to left through fixed columns, so tokens sit under tokens and elapsed
    // under elapsed no matter what the names alongside them are doing.
    var edge = right
    if showElapsed {
      if let trailing, !trailing.isEmpty {
        _ = drawRight(trailing, HUDStyle.num, HUDStyle.ink2, rightEdge: edge, y: baseline)
      }
      edge -= HUDStyle.colTokens
      _ = drawRight(
        duration(now - session.startedAt), HUDStyle.num, HUDStyle.ink3, rightEdge: edge,
        y: baseline)
      edge -= HUDStyle.colElapsed
      _ = draw(
        session.projectLabel, HUDStyle.body, HUDStyle.ink3,
        at: NSPoint(x: edge - HUDStyle.colProject, y: baseline), maxWidth: HUDStyle.colProject,
        alignment: .right)
      edge -= HUDStyle.colProject + HUDStyle.colGap
    } else {
      // A waiting row trades the numbers for the reason it is waiting, which is the
      // only thing on this card that is asking you for something.
      if let trailing, !trailing.isEmpty {
        let w = min(150, measure(trailing, HUDStyle.body.withSize(10.5)))
        _ = draw(
          trailing, HUDStyle.body.withSize(10.5), HUDStyle.waiting,
          at: NSPoint(x: edge - w, y: baseline), maxWidth: w, alignment: .right)
        edge -= w + HUDStyle.colGap
      }
      _ = draw(
        session.projectLabel, HUDStyle.body, HUDStyle.ink3,
        at: NSPoint(x: edge - HUDStyle.colProject, y: baseline), maxWidth: HUDStyle.colProject,
        alignment: .right)
      edge -= HUDStyle.colProject + HUDStyle.colGap
    }

    let labelX = left + HUDStyle.dot + 9
    _ = draw(
      session.label, HUDStyle.body, ink, at: NSPoint(x: labelX, y: baseline),
      maxWidth: max(20, edge - labelX))

    rowHits.append((NSRect(x: 0, y: y, width: bounds.width, height: h), session.cwd))
  }

  // MARK: Primitives

  private func attributes(_ font: NSFont, _ color: NSColor, tracking: CGFloat = 0)
    -> [NSAttributedString.Key: Any]
  {
    var a: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    if tracking != 0 { a[.kern] = tracking }
    return a
  }

  private func measure(_ s: String, _ font: NSFont) -> CGFloat {
    ceil(NSAttributedString(string: s, attributes: [.font: font]).size().width)
  }

  @discardableResult
  private func draw(
    _ s: String, _ font: NSFont, _ color: NSColor, at p: NSPoint, tracking: CGFloat = 0,
    maxWidth: CGFloat? = nil, alignment: NSTextAlignment = .left
  ) -> CGFloat {
    guard let maxWidth else {
      let attributed = NSAttributedString(
        string: s, attributes: attributes(font, color, tracking: tracking))
      attributed.draw(at: p)
      return ceil(attributed.size().width)
    }
    // Truncate the head, not the tail, for right-aligned columns: the end of a
    // project name is what distinguishes `…-worktrees` from `…-main`, and the end
    // is also where the eye lands when the column is flush right.
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = alignment == .right ? .byTruncatingHead : .byTruncatingTail
    style.alignment = alignment
    var attrs = attributes(font, color, tracking: tracking)
    attrs[.paragraphStyle] = style
    NSAttributedString(string: s, attributes: attrs)
      .draw(
        in: NSRect(x: p.x, y: p.y, width: maxWidth, height: font.ascender - font.descender + 2))
    return min(maxWidth, ceil(measure(s, font)))
  }

  @discardableResult
  private func drawRight(
    _ s: String, _ font: NSFont, _ color: NSColor, rightEdge: CGFloat, y: CGFloat
  ) -> CGFloat {
    let w = measure(s, font)
    _ = draw(s, font, color, at: NSPoint(x: rightEdge - w, y: y))
    return w
  }

  private func disc(_ r: NSRect, _ color: NSColor) {
    // A whisper of a halo. Enough that a live dot reads as lit rather than printed,
    // not enough to bloom at this size.
    color.withAlphaComponent(color.alphaComponent * 0.28).setFill()
    NSBezierPath(ovalIn: r.insetBy(dx: -2, dy: -2)).fill()
    color.setFill()
    NSBezierPath(ovalIn: r).fill()
  }

  private func ring(_ r: NSRect, _ color: NSColor, _ lineWidth: CGFloat) {
    let path = NSBezierPath(ovalIn: r.insetBy(dx: lineWidth / 2, dy: lineWidth / 2))
    path.lineWidth = lineWidth
    color.setStroke()
    path.stroke()
  }

  /// A ring showing what is left, drawn clockwise from twelve o'clock so it empties
  /// the way a gauge does.
  private func quotaRing(_ r: NSRect, _ left: Int) {
    let center = NSPoint(x: r.midX, y: r.midY)
    let radius = r.width / 2 - 1
    let track = NSBezierPath()
    track.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
    track.lineWidth = 2
    HUDStyle.track.setStroke()
    track.stroke()

    guard left > 0 else { return }
    let sweep = 360 * CGFloat(min(100, max(0, left))) / 100
    let path = NSBezierPath()
    path.appendArc(
      withCenter: center, radius: radius, startAngle: 90, endAngle: 90 - sweep, clockwise: true)
    path.lineWidth = 2
    path.lineCapStyle = .round
    HUDStyle.quota(left).setStroke()
    path.stroke()
  }

  private func meter(_ r: NSRect, _ left: Int) {
    let radius = r.height / 2
    HUDStyle.track.setFill()
    NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
    let w = r.width * CGFloat(min(100, max(0, left))) / 100
    guard w > 0 else { return }
    HUDStyle.quota(left).setFill()
    NSBezierPath(
      roundedRect: NSRect(x: r.minX, y: r.minY, width: max(r.height, w), height: r.height),
      xRadius: radius, yRadius: radius
    ).fill()
  }
}
