export type MainSection = "home" | "vocabulary" | "settings";

export interface RuntimeState {
  autoTranslateEnabled: boolean;
  mainSection: MainSection;
  targetCaptureAvailable: boolean;
}

export type DiagnosticEvent = "none" | "mouseDown" | "mouseUp" | "dragCandidate" | "doubleClickCandidate";
export type DiagnosticStage =
  | "idle" | "candidateDetected" | "waitingSelection" | "captureStarted"
  | "gateRejected" | "clipboardSnapshot" | "ctrlCSent"
  | "clipboardChanged" | "targetCaptured" | "targetFiltered" | "popupShow"
  | "popupEmit" | "popupAcknowledged" | "captureFailed";
export type DiagnosticResult = "none" | "success" | "ignored" | "failed";
export type CandidateType = "drag" | "doubleClick";
export type ClipboardRestoreState = "notNeeded" | "success" | "skipped" | "failed";
export type PopupWindowState = "notChecked" | "exists" | "missing";
export type PopupAttemptState = "notAttempted" | "pending" | "success" | "failed";
export type PopupListenerState = "ready" | "notReady";
export type PopupAckState = "notExpected" | "no" | "yes";

export interface SystemEventDiagnostic {
  hookReady: boolean;
  lastMouseEvent: DiagnosticEvent;
  candidateType?: CandidateType;
  reasonCode: string;
  foregroundTitle: string;
  foregroundPid: number;
  generation: number;
}

export interface ExternalCaptureDiagnostic {
  candidateType?: CandidateType;
  stage: DiagnosticStage;
  result: DiagnosticResult;
  reasonCode: string;
  targetPreview: string;
  targetLength: number;
  requestType?: RequestType;
  clipboardRestoreState: ClipboardRestoreState;
  popupWindowState: PopupWindowState;
  popupShowState: PopupAttemptState;
  popupEmitState: PopupAttemptState;
  popupListenerState: PopupListenerState;
  popupAckState: PopupAckState;
  captureGeneration: number;
  translationGeneration: number;
  foregroundTitle: string;
  foregroundPid: number;
}

export interface TargetDiagnostics {
  systemEvent: SystemEventDiagnostic;
  externalCapture: ExternalCaptureDiagnostic | null;
}

export type ClipboardFormatAvailability = "yes" | "no" | "error";
export type ClipboardStepState = "success" | "failed" | "notAttempted";
export type ClipboardTestResult = "success" | "failed";
export type ClipboardErrorStage =
  | "none"
  | "open_clipboard"
  | "format_unavailable"
  | "get_clipboard_data"
  | "global_lock"
  | "decode_utf16"
  | "empty_text"
  | "other";

export interface ClipboardUnicodeDiagnostic {
  formatAvailable: ClipboardFormatAvailability;
  getDataState: ClipboardStepState;
  globalLockState: ClipboardStepState;
  characterCount: number;
  result: ClipboardTestResult;
  errorStage: ClipboardErrorStage;
  reasonCode: string;
  lastError: number;
  textPreview: string;
}

export type RequestType = "wordAnalysis" | "sentenceTranslation";

export interface SelectionSnapshot {
  selectionId: string;
  captureGeneration: number;
  targetLength: number;
  requestType: RequestType;
  foregroundHwnd: string;
  foregroundPid: number;
  pageTitle: string;
  mouseX: number;
  mouseY: number;
  capturedAtUnixMs: number;
}

export interface SettingsView {
  schemaVersion: number;
  gatewayAccessConfigured: boolean;
}

export interface LatestGatewayTarget {
  target: string;
  requestType: RequestType;
  pageTitle: string;
  sourceApp: string;
  captureGeneration: number;
  translationGeneration: number;
  capturedAtUnixMs: number;
  context: {
    status: "success" | "unsupported" | "noSelection" | "mismatch" | "timeout" | "error";
    source: "uia" | "empty";
    unit: "paragraph" | "line" | "none";
    contextLength: number;
    contextPreview: string;
  };
}

export interface GatewayKeyTerm {
  term: string;
  meaning: string;
}

export type GatewayParsedResult =
  | {
      kind: "word";
      provider: string;
      upstreamProvider: string;
      skillVersion: string;
      word: string;
      lemma: string;
      phonetic: string;
      partOfSpeech: string;
      meaning: string;
    }
  | {
      kind: "sentence";
      provider: string;
      upstreamProvider: string;
      skillVersion: string;
      translation: string;
      keyTerm?: GatewayKeyTerm | null;
    };

export type GatewayConnectionState = "idle" | "sending" | "success" | "failed";
export type GatewayParseStatus = "notAttempted" | "success" | "failed";

export interface GatewayTestState {
  latestTarget?: LatestGatewayTarget | null;
  connectionState: GatewayConnectionState;
  requestId?: string | null;
  requestType?: RequestType | null;
  requestTargetLength?: number | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  parseStatus: GatewayParseStatus;
  parsedResult?: GatewayParsedResult | null;
  rawPreview?: string | null;
  errorCode?: string | null;
  gatewayErrorCode?: string | null;
  errorMessage?: string | null;
  liveErrorKind?: LivePopupErrorKind | null;
}

export interface GatewayAccessVerificationResult {
  success: boolean;
  gatewayAccessConfigured: boolean;
  httpStatus?: number | null;
  errorCode?: string | null;
  gatewayErrorCode?: string | null;
  message: string;
}

export type MockScenario =
  | "loading"
  | "wordSuccess"
  | "sentenceSuccess"
  | "error"
  | "retry";

export type MockPhase = "loading" | "success" | "error";
export type MockView = "loading" | "word" | "sentence" | "error";

export interface MockTranslationState {
  mock: true;
  generation: number;
  requestId: string;
  phase: MockPhase;
  view: MockView;
  title: string;
  body: string;
  phonetic?: string;
  partOfSpeech?: string;
  detail?: string;
  errorCode?: string;
  retryable: boolean;
  captureDiagnostic: boolean;
  target?: string;
  selection?: SelectionSnapshot;
}

export type PopupTranslationResult =
  | {
      kind: "word";
      word: string;
      lemma: string;
      phonetic: string;
      partOfSpeech: string;
      meaning: string;
    }
  | {
      kind: "sentence";
      translation: string;
      keyTerm?: GatewayKeyTerm | null;
    };

interface LivePopupBase {
  generation: number;
  captureGeneration: number;
  requestId: string;
  target: string;
}

export type LivePopupErrorKind = "retryable" | "configuration" | "terminal";

export type LivePopupTranslationState =
  | (LivePopupBase & {
      phase: "loading";
      requestType: RequestType;
    })
  | (LivePopupBase & {
      phase: "success";
      result: PopupTranslationResult;
    })
  | (LivePopupBase & {
      phase: "error";
      requestType: RequestType;
      errorKind: LivePopupErrorKind;
      message: string;
    });

export interface WordDetailResult {
  meaningInSentence: string;
  comparison?: {
    word: string;
    difference: string;
  } | null;
}

interface LiveDetailBase {
  generation: number;
  captureGeneration: number;
  quickRequestId: string;
  detailRequestId: string;
}

export type LiveDetailPopupState =
  | (LiveDetailBase & { phase: "loading" })
  | (LiveDetailBase & { phase: "success"; result: WordDetailResult })
  | (LiveDetailBase & { phase: "error"; message: string });

export interface VocabularySource {
  app: string;
  title: string;
  url?: string | null;
}

export interface VocabularyDetail {
  meaningInSentence: string;
  comparison?: { word: string; difference: string } | null;
}

export interface VocabularyEntry {
  id: string;
  key: string;
  word: string;
  lemma: string;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  context: string;
  source: VocabularySource;
  detail?: VocabularyDetail | null;
  createdAt: string;
  updatedAt: string;
}

export interface VocabularyListResult {
  entries: VocabularyEntry[];
  total: number;
}

export interface VocabularySaveResult {
  status: "saved" | "updated";
  entryId: string;
}

export interface VocabularyImportResult {
  cancelled: boolean;
  added: number;
  updated: number;
  total: number;
}

export interface VocabularyExportResult {
  cancelled: boolean;
  exported: number;
}

export interface StatusToast {
  enabled: boolean;
  message: string;
  generation: number;
}

export const EVENTS = {
  autoTranslateChanged: "auto-translate-changed",
  translationStateChanged: "translation-state-changed",
  statusToast: "status-toast",
  mainSectionChanged: "main-section-changed",
  targetCaptureDiagnostic: "target-capture-diagnostic",
  gatewayTargetChanged: "gateway-target-changed",
  popupTranslationState: "popup-translation-state",
  popupDetailState: "popup-detail-state",
  vocabularyChanged: "vocabulary-changed",
} as const;
