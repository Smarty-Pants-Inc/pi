export {
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthCallbackServerOptions,
} from "./callback.ts";
export {
	buildAuthorizationServerDiscoveryUrls,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	parseWwwAuthenticate,
	resourceUrlFromServerUrl,
	selectResource,
} from "./discovery.ts";
export {
	McpOAuthAuthorizationRequiredError,
	OAuthEndpointOriginError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRedirectRefusedError,
	OAuthRegistrationError,
	OAuthResourceMismatchError,
} from "./errors.ts";
// startAuthorization, registerClient, exchangeAuthorizationCode and refreshAuthorization stay internal:
// they trust the metadata they are given, while authorizeMcp binds its endpoints to the issuer origin
// (and allowedEndpointOrigins) first. Exporting them would let a caller skip that check (pi#173).
export {
	type AddClientAuthentication,
	adaptOAuthProvider,
	authorizeMcp,
	type OAuthClientMetadataDocument,
	type OAuthClientProvider,
	type OAuthFlowOptions,
	type OAuthFlowResult,
	stepUpScope,
} from "./flow.ts";
export {
	McpOAuthProvider,
	type McpOAuthProviderOptions,
	type McpOAuthState,
	type McpOAuthStateStore,
	MemoryOAuthStateStore,
} from "./provider.ts";
export type {
	AuthorizationServerMetadata,
	OAuthChallenge,
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthProtectedResourceMetadata,
	OAuthServerInfo,
	OAuthTokens,
} from "./types.ts";
