import UIKit
import UniformTypeIdentifiers

/// "Share to Iskra" from other apps: copies the text, links and files into the App Group (ShareInbox.swift), then
/// opens Iskra (iskra://share), where the page asks where it goes. Nothing is sent from here. Files are copied on disk,
/// never read into memory (an extension has about 120 MB).
final class ShareViewController: UIViewController {
    private let spinner = UIActivityIndicatorView(style: .large)
    private let label = UILabel()
    private let doneButton = UIButton(type: .system)
    private var started = false

    private static let swedish = Locale.preferredLanguages.first?.hasPrefix("sv") == true
    private static func text(_ en: String, _ sv: String) -> String { swedish ? sv : en }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = Self.text("Getting it ready for Iskra…", "Gör klart för Iskra …")
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        doneButton.setTitle(Self.text("Done", "Klar"), for: .normal)
        doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        doneButton.isHidden = true
        doneButton.addTarget(self, action: #selector(done), for: .touchUpInside)
        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [spinner, label, doneButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { @MainActor in await self.run() }
    }

    @objc private func done() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func show(_ message: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        label.text = message
        doneButton.isHidden = false
    }

    @MainActor
    private func run() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let id = UUID().uuidString
        guard let dir = ShareInbox.folder(id) else {
            show(Self.text("Iskra couldn't take this share.", "Iskra kunde inte ta emot det här."))
            return
        }
        let saved = await Task.detached(priority: .userInitiated) { Self.save(items, id: id, dir: dir) }.value
        guard saved else {
            try? FileManager.default.removeItem(at: dir)
            show(Self.text("There was nothing Iskra can share here.", "Det fanns inget här som Iskra kan dela."))
            return
        }
        if let url = URL(string: "iskra://share?id=\(id)"), openApp(url) {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        } else {
            // The app picks it up the next time it opens.
            show(Self.text("Ready. Open Iskra to choose where it goes.", "Klart. Öppna Iskra och välj vart det ska."))
        }
    }

    /**
     * Opens the app from the extension: the documented `extensionContext.open` only works for Today and iMessage
     * extensions, so this asks the UIApplication in the responder chain (UIApplication.shared isn't available here).
     */
    private func openApp(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication, application.responds(to: selector) {
                typealias Open = @convention(c) (NSObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(application.method(for: selector), to: Open.self)
                open(application, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }

    // ── Copying (off the main thread) ──────────────────────────────────────

    private enum Taken {
        case text(String)
        case file(ShareInbox.File)
        case skipped
    }

    /** Copies everything and writes share.json last. False when there was nothing usable. */
    private static func save(_ items: [NSExtensionItem], id: String, dir: URL) -> Bool {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            if var root = ShareInbox.root {
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? root.setResourceValues(values)
            }
        } catch {
            return false
        }
        var texts: [String] = []
        var subject: String?
        var files: [ShareInbox.File] = []
        var skipped = 0
        func addText(_ s: String?) {
            guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !texts.contains(t) else { return }
            texts.append(t)
        }
        for item in items {
            if subject == nil, let title = item.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                subject = title
            }
            addText(item.attributedContentText?.string)
            for provider in item.attachments ?? [] {
                let isFile = !isText(provider) && !isWebLink(provider)
                if isFile && files.count >= ShareInbox.maxFiles {
                    skipped += 1
                    continue
                }
                switch take(provider, index: files.count + 1, dir: dir) {
                case .text(let t): addText(t)
                case .file(let f): files.append(f)
                case .skipped: skipped += 1
                }
            }
        }
        let text = ShareInbox.limit(texts.joined(separator: "\n"), ShareInbox.maxText)
        if text.isEmpty && files.isEmpty { return false }
        let manifest = ShareInbox.Manifest(
            id: id, created: Date().timeIntervalSince1970, text: text.isEmpty ? nil : text,
            subject: subject.map { ShareInbox.limit($0, ShareInbox.maxSubject) }, files: files, skipped: skipped)
        guard let data = try? JSONEncoder().encode(manifest) else { return false }
        do {
            try data.write(to: dir.appendingPathComponent(ShareInbox.manifestName), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func conforms(_ provider: NSItemProvider, _ type: UTType) -> Bool {
        provider.hasItemConformingToTypeIdentifier(type.identifier)
    }

    /** A web link (not a file's URL). */
    private static func isWebLink(_ provider: NSItemProvider) -> Bool {
        conforms(provider, .url) && !conforms(provider, .fileURL)
    }

    /** Plain text from an app (Notes, a selection), not a text file from Files. */
    private static func isText(_ provider: NSItemProvider) -> Bool {
        guard conforms(provider, .plainText), !conforms(provider, .fileURL) else { return false }
        return provider.registeredTypeIdentifiers.allSatisfy { UTType($0)?.conforms(to: .text) ?? false }
    }

    private static func take(_ provider: NSItemProvider, index: Int, dir: URL) -> Taken {
        if isWebLink(provider) {
            guard let item = load(provider, UTType.url.identifier) else { return .skipped }
            if let url = item as? URL, !url.isFileURL { return .text(url.absoluteString) }
            if let s = item as? String { return .text(s) }
            return .skipped
        }
        if isText(provider) {
            switch load(provider, UTType.plainText.identifier) {
            case let s as String: return .text(s)
            case let s as NSAttributedString: return .text(s.string)
            case let d as Data: return String(data: d, encoding: .utf8).map { .text($0) } ?? .skipped
            default: return .skipped
            }
        }
        return copyFile(provider, index: index, dir: dir).map { .file($0) } ?? .skipped
    }

    /** NSItemProvider.loadItem, waited for (this runs on a background thread). */
    private static func load(_ provider: NSItemProvider, _ type: String) -> NSSecureCoding? {
        let done = DispatchSemaphore(value: 0)
        var result: NSSecureCoding?
        provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
            result = item
            done.signal()
        }
        done.wait()
        return result
    }

    /** The provider's most specific data type ("public.jpeg" before "public.image"). */
    private static func contentType(_ provider: NSItemProvider) -> UTType? {
        for id in provider.registeredTypeIdentifiers {
            guard let type = UTType(id), type != .fileURL, type != .url else { continue }
            if type.conforms(to: .data) || type.conforms(to: .content) { return type }
        }
        return nil
    }

    private static func copyFile(_ provider: NSItemProvider, index: Int, dir: URL) -> ShareInbox.File? {
        let type = contentType(provider)
        var copied: (URL, String)?
        if let type {
            // A file the system hands over for the length of the callback: copy it there, on disk.
            let done = DispatchSemaphore(value: 0)
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                if let url { copied = Self.copy(url, name: provider.suggestedName, type: type, index: index, dir: dir) }
                done.signal()
            }
            done.wait()
        }
        if copied == nil, conforms(provider, .fileURL), let url = load(provider, UTType.fileURL.identifier) as? URL, url.isFileURL {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            copied = copy(url, name: provider.suggestedName, type: type ?? UTType(filenameExtension: url.pathExtension), index: index, dir: dir)
        }
        if copied == nil, let type, type.conforms(to: .image) {
            // Some apps hand over an image only as a UIImage (a screenshot being edited).
            copied = writeImage(load(provider, type.identifier), name: provider.suggestedName, type: type, index: index, dir: dir)
        }
        guard let copied, let size = (try? copied.0.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { return nil }
        let (target, name) = copied
        // By the copy's extension first: it always matches the bytes (an image handed over as a UIImage is a PNG).
        let ext = (name as NSString).pathExtension
        let mime = (ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType)
            ?? type?.preferredMIMEType
            ?? "application/octet-stream"
        return ShareInbox.File(name: name, type: mime, size: Int64(size), file: target.lastPathComponent)
    }

    /** Copies a file (too big ones are skipped) and returns where it went with its clean name. */
    private static func copy(_ source: URL, name: String?, type: UTType?, index: Int, dir: URL) -> (URL, String)? {
        guard let size = (try? source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])),
              size.isRegularFile == true, Int64(size.fileSize ?? 0) <= ShareInbox.maxFileBytes else { return nil }
        let clean = named(name ?? source.lastPathComponent, type: type)
        let target = dir.appendingPathComponent(ShareInbox.diskName(index: index, name: clean))
        do {
            try FileManager.default.copyItem(at: source, to: target)
            return (target, clean)
        } catch {
            return nil
        }
    }

    private static func writeImage(_ item: NSSecureCoding?, name: String?, type: UTType, index: Int, dir: URL) -> (URL, String)? {
        let data: Data?
        var kind = type
        switch item {
        case let image as UIImage:
            data = image.pngData()
            kind = .png
        case let d as Data:
            data = d
        default:
            data = nil
        }
        guard let data, Int64(data.count) <= ShareInbox.maxFileBytes else { return nil }
        var clean = named(name ?? "image", type: kind)
        if kind == .png && (clean as NSString).pathExtension.lowercased() != "png" { clean = "\((clean as NSString).deletingPathExtension).png" }
        let target = dir.appendingPathComponent(ShareInbox.diskName(index: index, name: clean))
        do {
            try data.write(to: target)
            return (target, clean)
        } catch {
            return nil
        }
    }

    /** A clean name with an extension that matches the type ("IMG_0001" + jpeg → "IMG_0001.jpeg"). */
    private static func named(_ name: String, type: UTType?) -> String {
        let clean = ShareInbox.cleanName(name, type: type)
        if (clean as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { return "\(clean).\(ext)" }
        return clean
    }
}
