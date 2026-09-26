// Build-time team colour swatches (not shipped). Renders a rounded colour tile per team.
// Usage: swift tools/make_swatches.swift tools/teams.json src
// teams.json: { "mercedes": "#27F4D2", ... } -> src/icons/team-mercedes.png (128 px)
import AppKit

func color(_ hex: String) -> NSColor {
    var v: UInt64 = 0
    Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

func render(hex: String, size: CGFloat, to path: String) throws {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = size * 0.14
    let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    let tile = NSBezierPath(roundedRect: rect, xRadius: size * 0.18, yRadius: size * 0.18)
    let base = color(hex)
    NSGradient(starting: base.blended(withFraction: 0.15, of: .white)!, ending: base.blended(withFraction: 0.15, of: .black)!)!
        .draw(in: tile, angle: -90)
    // a thin outline keeps very dark or very light colours visible on any Alfred theme
    NSColor(white: 0.5, alpha: 0.6).setStroke()
    tile.lineWidth = size * 0.03
    tile.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let args = CommandLine.arguments
let spec = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: String]
let src = args[2]
try FileManager.default.createDirectory(atPath: "\(src)/icons", withIntermediateDirectories: true)
var n = 0
for (name, hex) in spec.sorted(by: { $0.key < $1.key }) where !name.hasPrefix("_") {
    try render(hex: hex, size: 128, to: "\(src)/icons/team-\(name).png")
    n += 1
}
print("Rendered \(n) team swatches")
