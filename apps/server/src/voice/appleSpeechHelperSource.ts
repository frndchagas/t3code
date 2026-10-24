/**
 * Swift source the server compiles once per host (SpeechAnalyzer is Swift-only); exit codes: 2
 * unavailable, 3 unsupported locale, 1 other. With several candidate languages it transcribes with
 * each and keeps the best confidence weighted by how much the text reads as that language, since
 * confidence alone picks Portuguese for "Yes, go ahead".
 */
export const APPLE_SPEECH_HELPER_SOURCE = String.raw`
import AVFoundation
import Foundation
import NaturalLanguage
import Speech

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
    fail(1, "Could not encode the result.")
  }
  FileHandle.standardOutput.write(data)
}

@available(macOS 26, *)
func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
  SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.transcriptionConfidence]
  )
}

/// Resolves each requested language to a supported model, one per language, with assets installed.
@available(macOS 26, *)
func prepareLocales(_ languages: [String]) async throws -> [Locale] {
  var locales: [Locale] = []
  for language in languages {
    guard
      let locale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: language))
    else { continue }
    // Detection chooses between languages; a second region of one language adds no choice.
    if locales.contains(where: { $0.language.languageCode == locale.language.languageCode }) {
      continue
    }
    let transcriber = makeTranscriber(locale)
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
      break
    case .unsupported:
      continue
    default:
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
    }
    locales.append(locale)
  }
  if locales.isEmpty {
    fail(3, "Unsupported locales: \(languages.joined(separator: ", "))")
  }
  return locales
}

struct Transcript: Sendable {
  let text: String
  /// Mean recognizer confidence, weighted by characters.
  let confidence: Double
}

@available(macOS 26, *)
func transcribe(_ url: URL, in locale: Locale) async throws -> Transcript {
  let transcriber = makeTranscriber(locale)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let collector = Task { () throws -> Transcript in
    var segments: [String] = []
    var weighted = 0.0
    var characters = 0.0
    for try await result in transcriber.results where result.isFinal {
      segments.append(String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines))
      for run in result.text.runs {
        guard let confidence = run.transcriptionConfidence else { continue }
        let count = Double(result.text[run.range].characters.count)
        weighted += confidence * count
        characters += count
      }
    }
    return Transcript(
      text: segments.filter { !$0.isEmpty }.joined(separator: " "),
      confidence: characters > 0 ? weighted / characters : 0
    )
  }
  do {
    let file = try AVAudioFile(forReading: url)
    if let lastSample = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collector.value
  } catch {
    collector.cancel()
    await analyzer.cancelAndFinishNow()
    throw error
  }
}

@available(macOS 26, *)
func likeliest(_ transcripts: [(Locale, Transcript)]) -> (Locale, Transcript) {
  let languages = transcripts.compactMap { locale, _ in
    locale.language.languageCode.map { NLLanguage(rawValue: $0.identifier) }
  }
  func score(_ locale: Locale, _ transcript: Transcript) -> Double {
    let recognizer = NLLanguageRecognizer()
    recognizer.languageConstraints = languages
    recognizer.processString(transcript.text)
    let language = locale.language.languageCode.map { NLLanguage(rawValue: $0.identifier) }
    let probability = language.flatMap { recognizer.languageHypotheses(withMaximum: languages.count)[$0] } ?? 0
    return transcript.confidence * (0.1 + probability)
  }
  return transcripts.max { score($0.0, $0.1) < score($1.0, $1.1) } ?? transcripts[0]
}

@main
struct T3Speech {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    guard #available(macOS 26, *) else { fail(2, "Requires macOS 26 or later.") }
    guard SpeechTranscriber.isAvailable else { fail(2, "Speech transcription is unavailable.") }
    do {
      if args.count >= 2 && args[0] == "prepare" {
        let locales = try await prepareLocales(Array(args.dropFirst()))
        emit(["locales": locales.map { $0.identifier(.bcp47) }])
      } else if args.count >= 3 && args[0] == "transcribe" {
        let url = URL(fileURLWithPath: args[1])
        let locales = try await prepareLocales(Array(args.dropFirst(2)))
        let transcripts = try await withThrowingTaskGroup(of: (Int, Transcript).self) { group in
          for (index, locale) in locales.enumerated() {
            group.addTask { (index, try await transcribe(url, in: locale)) }
          }
          var results: [(Int, Transcript)] = []
          for try await result in group { results.append(result) }
          return results.sorted { $0.0 < $1.0 }.map { (locales[$0.0], $0.1) }
        }
        let (locale, transcript) = likeliest(transcripts)
        emit(["text": transcript.text, "locale": locale.identifier(.bcp47)])
      } else {
        fail(64, "usage: t3-speech prepare <locale>... | transcribe <file> <locale>...")
      }
    } catch {
      fail(1, "\(error)")
    }
  }
}
`;
