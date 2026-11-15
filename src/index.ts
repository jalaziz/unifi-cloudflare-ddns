import { ClientOptions, Cloudflare } from 'cloudflare';
import type { AAAARecord, ARecord } from 'cloudflare/resources/dns/records';
import type { Zone } from 'cloudflare/resources/zones/zones';
type AddressableRecord = AAAARecord | ARecord;

class HttpError extends Error {
	constructor(
		public statusCode: number,
		message: string,
	) {
		super(message);
		this.name = 'HttpError';
	}
}

function constructClientOptions(request: Request): ClientOptions {
	const authorization = request.headers.get('Authorization');
	if (!authorization) {
		throw new HttpError(401, 'API token missing.');
	}

	const [, data] = authorization.split(' ');
	const decoded = atob(data);
	const index = decoded.indexOf(':');

	if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
		throw new HttpError(401, 'Invalid API key or token.');
	}

	return {
		apiEmail: decoded.substring(0, index),
		apiToken: decoded.substring(index + 1),
	};
}

function constructDNSRecords(request: Request): AddressableRecord[] {
	const url = new URL(request.url);
	const params = url.searchParams;
	let ip = (params.get('ip') || params.get('myip'))?.trim() || null;
	const ip6 = params.get('ip6')?.trim() || null;
	const hostname = params.get('hostname')?.trim() || null;

	if (ip === null || ip === undefined) {
		throw new HttpError(422, 'The "ip" parameter is required and cannot be empty. Specify ip=auto to use the client IP.');
	} else if (ip == 'auto') {
		ip = request.headers.get('CF-Connecting-IP');
		if (ip === null) {
			throw new HttpError(500, 'Request asked for ip=auto but client IP address cannot be determined.');
		}
	}

	if (hostname === null || hostname === undefined) {
		throw new HttpError(422, 'The "hostname" parameter is required and cannot be empty.');
	}

	const hostnames = hostname.split(',').map((h) => h.trim()).filter(Boolean);
	if (hostnames.length === 0) {
		throw new HttpError(422, 'The "hostname" parameter is required and cannot be empty.');
	}

	const records: AddressableRecord[] = [];

	for (const name of hostnames) {
		records.push({
			content: ip,
			name,
			type: ip.includes('.') ? 'A' : 'AAAA',
			ttl: 1,
		});

		if (ip6 !== null && ip6 !== undefined) {
			if (!ip6.includes(':')) {
				throw new HttpError(422, 'The "ip6" parameter must be a valid IPv6 address.');
			}
			records.push({
				content: ip6,
				name,
				type: 'AAAA',
				ttl: 1,
			});
		}
	}

	return records;
}

/**
 * Pick the zone a hostname belongs to. A token scoped to a single zone always
 * uses that zone; otherwise the zone with the longest matching suffix wins
 * (so `a.sub.example.com` prefers a `sub.example.com` zone over `example.com`).
 */
function findZone(zones: Zone[], hostname: string): Zone {
	if (zones.length === 1) {
		return zones[0];
	}

	const host = hostname.toLowerCase().replace(/\.$/, '');
	let match: Zone | undefined;
	for (const zone of zones) {
		const name = zone.name.toLowerCase();
		if ((host === name || host.endsWith('.' + name)) && (!match || name.length > match.name.length)) {
			match = zone;
		}
	}

	if (!match) {
		throw new HttpError(400, `No zone found for hostname "${hostname}". Make sure the API Token has access to its zone.`);
	}
	return match;
}

async function update(clientOptions: ClientOptions, newRecords: AddressableRecord[]): Promise<Response> {
	const cloudflare = new Cloudflare(clientOptions);

	const tokenStatus = (await cloudflare.user.tokens.verify()).status;
	if (tokenStatus !== 'active') {
		throw new HttpError(401, 'This API Token is ' + tokenStatus);
	}

	const zones: Zone[] = [];
	for await (const zone of cloudflare.zones.list({ per_page: 50 })) {
		zones.push(zone);
	}
	if (zones.length === 0) {
		throw new HttpError(400, 'No zones found! The API Token must have access to at least one zone.');
	}

	for (const newRecord of newRecords) {
		const zone = findZone(zones, newRecord.name);
		const records = (
			await cloudflare.dns.records.list({
				zone_id: zone.id,
				name: newRecord.name as any,
				type: newRecord.type,
			})
		).result;

		if (records.length > 1) {
			throw new HttpError(400, 'More than one matching record found!');
		} else if (records.length === 0 || records[0].id === undefined) {
			throw new HttpError(400, 'No record found! You must first manually create the record.');
		}

		// Extract current properties
		const currentRecord = records[0] as AddressableRecord;
		const proxied = currentRecord.proxied ?? false; // Default to `false` if `proxied` is undefined
		const comment = currentRecord.comment;

		await cloudflare.dns.records.update(records[0].id, {
			content: newRecord.content,
			zone_id: zone.id,
			name: newRecord.name as any,
			type: newRecord.type,
			ttl: newRecord.ttl,
			proxied, // Pass the existing "proxied" status
			comment, // Pass the existing "comment"
		});

		console.log('DNS record for ' + newRecord.name + '(' + newRecord.type + ') updated successfully to ' + newRecord.content);
	}

	return new Response('OK', { status: 200 });
}

export default {
	async fetch(request): Promise<Response> {
		console.log('Requester IP: ' + request.headers.get('CF-Connecting-IP'));
		console.log(request.method + ': ' + request.url);
		console.log('Body: ' + (await request.text()));

		try {
			// Construct client options and DNS records
			const clientOptions = constructClientOptions(request);
			const records = constructDNSRecords(request);

			// Run the update function
			return await update(clientOptions, records);
		} catch (error) {
			if (error instanceof HttpError) {
				logFailure(request, error.statusCode, error);
				return new Response(error.message, { status: error.statusCode });
			} else {
				logFailure(request, 500, error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * Shape of errors thrown by the Cloudflare SDK (`APIError` and subclasses).
 * Duck-typed so it works without importing the SDK's error classes.
 */
interface CloudflareApiErrorLike extends Error {
	status: number | undefined;
	errors: unknown;
}

function isCloudflareApiError(error: unknown): error is CloudflareApiErrorLike {
	return error instanceof Error && 'status' in error && 'errors' in error;
}

/**
 * Emit a structured error log for a failed request. Never logs the
 * Authorization header or decoded credentials.
 */
function logFailure(request: Request, responseStatus: number, error: unknown): void {
	const url = new URL(request.url);
	const entry: Record<string, unknown> = {
		message: 'DDNS update failed',
		responseStatus,
		method: request.method,
		path: url.pathname,
		hostname: url.searchParams.get('hostname'),
		ip: url.searchParams.get('ip') ?? url.searchParams.get('myip'),
		ip6: url.searchParams.get('ip6'),
		clientIp: request.headers.get('CF-Connecting-IP'),
		userAgent: request.headers.get('User-Agent'),
	};

	if (error instanceof HttpError) {
		entry.error = { name: error.name, message: error.message };
	} else if (isCloudflareApiError(error)) {
		entry.error = {
			name: error.name,
			message: error.message,
			apiStatus: error.status,
			apiErrors: error.errors,
			stack: error.stack,
		};
	} else if (error instanceof Error) {
		entry.error = { name: error.name, message: error.message, stack: error.stack };
	} else {
		entry.error = { message: String(error) };
	}

	console.error(entry);
}
