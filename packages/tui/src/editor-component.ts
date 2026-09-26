import type { AutocompleteProvider } from "./autocomplete.ts";
import type { InputOrigin } from "./input-origin.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	/** Replace the content; non-empty text without `origin` has unknown origin. */
	setText(text: string, origin?: InputOrigin): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key). `origin` says who produced the submitted text. */
	onSubmit?: (text: string, origin?: InputOrigin) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Origin of the current content since the last submit or clear. */
	getInputOrigin?(): InputOrigin;

	/** Adds an origin to the current content, for content inserted outside `handleInput`. */
	addInputOrigin?(origin: InputOrigin): void;

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string, origin?: InputOrigin): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
