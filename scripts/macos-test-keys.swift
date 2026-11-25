// Deliver key events only to the disposable application under test.
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments.dropFirst()
guard let target = arguments.first.flatMap(Int32.init), target > 0,
      CGPreflightPostEventAccess() else { exit(2) }

for key in arguments.dropFirst() {
    guard let code = UInt16(key) else { exit(3) }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
        else { exit(4) }
        event.postToPid(target)
        Thread.sleep(forTimeInterval: 0.07)
    }
}
