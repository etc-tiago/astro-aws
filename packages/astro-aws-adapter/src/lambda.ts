// eslint-disable-next-line eslint-comments/disable-enable-pair
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
import { Buffer } from "node:buffer";

import { polyfill } from "@astrojs/webapi";
import type { Handler } from "aws-lambda";
import type { SSRManifest } from "astro";
import { App } from "astro/app";

import type { Args } from "./args.js";

polyfill(globalThis, {
	exclude: "window document",
});

const parseContentType = (header?: string) => header?.split(";")[0] ?? "";

const clientAddressSymbol = Symbol.for("astro.clientAddress");

export const createExports = (manifest: SSRManifest, { binaryMediaTypes }: Args) => {
	const app = new App(manifest);

	const knownBinaryMediaTypes = new Set([
		"audio/3gpp",
		"audio/3gpp2",
		"audio/aac",
		"audio/midi",
		"audio/mpeg",
		"audio/ogg",
		"audio/opus",
		"audio/wav",
		"audio/webm",
		"audio/x-midi",
		"image/avif",
		"image/bmp",
		"image/gif",
		"image/heif",
		"image/ico",
		"image/jpeg",
		"image/png",
		"image/svg+xml",
		"image/tiff",
		"image/vnd.microsoft.icon",
		"image/webp",
		"video/3gpp",
		"video/3gpp2",
		"video/mp2t",
		"video/mp4",
		"video/mpeg",
		"video/ogg",
		"video/webm",
		"video/x-msvideo",
		...(binaryMediaTypes ?? []),
	]);

	const handler: Handler = async (event) => {
		console.log(JSON.stringify(event, undefined, 2));

		const {
			httpMethod,
			body: requestBody,
			isBase64Encoded,
			rawPath,
			requestContext: { domainName },
		} = event;

		const headers = new Headers(event.headers as Record<string, string>);

		const init: RequestInit = {
			headers,
			method: httpMethod as string,
		};

		if (httpMethod !== "GET" && httpMethod !== "HEAD") {
			const encoding = isBase64Encoded ? "base64" : "utf-8";

			init.body = typeof requestBody === "string" ? Buffer.from(requestBody, encoding) : (requestBody as string);
		}

		const request = new Request(
			new URL(rawPath as string, `https://${(domainName as string | undefined) ?? headers.get("host") ?? "fake.com"}`),
			init,
		);

		const routeData = app.match(request, { matchNotFound: true });

		if (!routeData) {
			return {
				body: "Not found",
				statusCode: 404,
			};
		}

		const ip = headers.get("x-forwarded-for");

		Reflect.set(request, clientAddressSymbol, ip);

		const response: Response = await app.render(request, routeData);
		const responseHeaders = Object.fromEntries(response.headers.entries());

		const responseContentType = parseContentType(responseHeaders["content-type"]);
		const responseIsBase64Encoded = knownBinaryMediaTypes.has(responseContentType);

		let responseBody: string;

		if (responseIsBase64Encoded) {
			const ab = await response.arrayBuffer();

			responseBody = Buffer.from(ab).toString("base64");
		} else {
			responseBody = await response.text();
		}

		const fnResponse: any = {
			body: responseBody,
			headers: responseHeaders,
			isBase64Encoded: responseIsBase64Encoded,
			statusCode: response.status,
		};

		// Special-case set-cookie which has to be set an different way :/
		// The fetch API does not have a way to get multiples of a single header, but instead concatenates
		// them. There are non-standard ways to do it, and node-fetch gives us headers.raw()
		// See https://github.com/whatwg/fetch/issues/973 for discussion
		if (response.headers.has("set-cookie") && "raw" in response.headers) {
			// Node fetch allows you to get the raw headers, which includes multiples of the same type.
			// This is needed because Set-Cookie *must* be called for each cookie, and can't be
			// concatenated together.
			type HeadersWithRaw = Headers & {
				raw: () => Record<string, string[]>;
			};

			const rawPacked = (response.headers as HeadersWithRaw).raw();

			if ("set-cookie" in rawPacked) {
				fnResponse.multiValueHeaders = {
					"set-cookie": rawPacked["set-cookie"],
				};
			}
		}

		// Apply cookies set via Astro.cookies.set/delete
		const setCookieHeaders = [...app.setCookieHeaders(response)];

		fnResponse.multiValueHeaders = fnResponse.multiValueHeaders || {};

		if (!fnResponse.multiValueHeaders["set-cookie"]) {
			fnResponse.multiValueHeaders["set-cookie"] = [];
		}

		fnResponse.multiValueHeaders["set-cookie"].push(...setCookieHeaders);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return fnResponse;
	};

	return { handler };
};
