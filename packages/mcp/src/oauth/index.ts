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
// The token operations stay public (documented API since 1.0.x), and each binds its endpoints to the issuer
// origin (and allowedEndpointOrigins) itself before any request, as authorizeMcp does (pi#173).
export {
	type AddClientAuthentication,
	adaptOAuthProvider,
	authorizeMcp,
	exchangeAuthorizationCode,
	type OAuthClientMetadataDocument,
	type OAuthClientProvider,
	type OAuthFlowOptions,
	type OAuthFlowResult,
	refreshAuthorization,
	registerClient,
	startAuthorization,
	stepUpScope,
	type TokenRequestOptions,
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
