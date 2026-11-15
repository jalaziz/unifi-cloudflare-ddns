import worker from '../src/index';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock functions
const mockListZones = vi.fn();
const mockListRecords = vi.fn();
const mockUpdateRecord = vi.fn();

vi.mock('cloudflare', () => {
	return {
		Cloudflare: vi.fn().mockImplementation(function () {
			return {
				zones: {
					// The SDK returns a PagePromise: awaitable for one page, async-iterable across all pages.
					list: (...args: unknown[]) => {
						const page = Promise.resolve(mockListZones(...args));
						return {
							then: page.then.bind(page),
							async *[Symbol.asyncIterator]() {
								yield* (await page).result;
							},
						};
					},
				},
				dns: {
					records: {
						list: mockListRecords,
						update: mockUpdateRecord,
					},
				},
			};
		}),
	};
});

describe('UniFi DDNS Worker', () => {
	beforeEach(() => {
		// Clear all mocks before each test to prevent state leakage
		vi.clearAllMocks();
	});

	it('responds with 401 when API token is missing', async () => {
		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com'));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('API token missing.');
	});

	it('responds with 401 when API token is invalid', async () => {
		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				// CodeQL [js/hardcoded-credentials] Suppressing hardcoded credential warning for test
				Authorization: 'Basic invalidtoken',
			},
		}));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Invalid API key or token.');
	});

	it.each([400, 401, 403])('responds with 401 when the API rejects the token (%i)', async (status) => {
		mockListZones.mockRejectedValueOnce(
			Object.assign(new Error(`${status} Authentication error`), { status, errors: [{ code: 10000, message: 'Authentication error' }] }),
		);

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('The API Token is invalid, expired, or lacks Zone:Read permission.');
		expect(mockListRecords).not.toHaveBeenCalled();
	});

	it('responds with 422 when IP is missing', async () => {
		const response = await worker.fetch(new Request('http://example.com/update?hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));
		expect(response.status).toBe(422);
		expect(await response.text()).toBe('The "ip" parameter is required and cannot be empty. Specify ip=auto to use the client IP.');
	});

	it('responds with 500 when IP is set to auto and is missing', async () => {
		const response = await worker.fetch(new Request('http://example.com/update?hostname=home.example.com&ip=auto', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Request asked for ip=auto but client IP address cannot be determined.');
	});

	it('responds with 422 when hostname is missing', async () => {
		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));
		expect(response.status).toBe(422);
		expect(await response.text()).toBe('The "hostname" parameter is required and cannot be empty.');
	});

	it('responds with 200 on valid update', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords.mockResolvedValueOnce({ result: [{ id: 'record-id', name: 'home.example.com', type: 'A' }] });
		mockUpdateRecord.mockResolvedValueOnce({});

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));
		expect(response.status).toBe(200);
	});

	it('responds with 200 on valid update when IP is set to auto', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords.mockResolvedValueOnce({ result: [{ id: 'record-id', name: 'home.example.com', type: 'A' }] });
		mockUpdateRecord.mockResolvedValueOnce({});

		const response = await worker.fetch(new Request('http://example.com/update?ip=auto&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				'CF-Connecting-IP': '192.0.2.1',
			},
		}));
		expect(response.status).toBe(200);
	});

	it('responds with 200 on valid multi-hostname update', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords
			.mockResolvedValueOnce({ result: [{ id: 'record-id-1', name: 'example.com', type: 'A' }] })
			.mockResolvedValueOnce({ result: [{ id: 'record-id-2', name: '*.example.com', type: 'A' }] });
		mockUpdateRecord.mockResolvedValue({});

		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&hostname=example.com,*.example.com', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
	});

	it('responds with 200 on multi-hostname dual-stack update', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords
			.mockResolvedValueOnce({ result: [{ id: 'record-id-a1', name: 'example.com', type: 'A' }] })
			.mockResolvedValueOnce({ result: [{ id: 'record-id-aaaa1', name: 'example.com', type: 'AAAA' }] })
			.mockResolvedValueOnce({ result: [{ id: 'record-id-a2', name: 'sub.example.com', type: 'A' }] })
			.mockResolvedValueOnce({ result: [{ id: 'record-id-aaaa2', name: 'sub.example.com', type: 'AAAA' }] });
		mockUpdateRecord.mockResolvedValue({});

		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&ip6=2001:0db8:85a3:0000:0000:8a2e:0370:7334&hostname=example.com,sub.example.com', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(mockUpdateRecord).toHaveBeenCalledTimes(4);
	});

	it('routes each hostname to its matching zone when the token covers multiple zones', async () => {
		mockListZones.mockResolvedValueOnce({
			result: [
				{ id: 'zone-example', name: 'example.com' },
				{ id: 'zone-sub', name: 'sub.example.com' },
				{ id: 'zone-other', name: 'other.net' },
			],
		});
		mockListRecords.mockResolvedValue({ result: [{ id: 'record-id', proxied: false }] });

		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com,a.sub.example.com,Other.NET', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(mockListRecords.mock.calls.map(([params]) => [params.name, params.zone_id])).toEqual([
			['home.example.com', 'zone-example'],
			['a.sub.example.com', 'zone-sub'],
			['Other.NET', 'zone-other'],
		]);
		expect(mockUpdateRecord.mock.calls.map(([, params]) => params.zone_id)).toEqual(['zone-example', 'zone-sub', 'zone-other']);
	});

	it('responds with 400 when no accessible zone matches the hostname', async () => {
		mockListZones.mockResolvedValueOnce({
			result: [
				{ id: 'zone-example', name: 'example.com' },
				{ id: 'zone-other', name: 'other.net' },
			],
		});

		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&hostname=home.notexample.com', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('No zone found for hostname "home.notexample.com". Make sure the API Token has access to its zone.');
		expect(mockUpdateRecord).not.toHaveBeenCalled();
	});

	it('responds with 400 when no zones are found', async () => {
		mockListZones.mockResolvedValueOnce({ result: [] });

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('No zones found! The API Token must have access to at least one zone.');
	});

	it('responds with 400 when multiple records are found', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords.mockResolvedValueOnce({
			result: [
				{ id: 'record-id1', name: 'home.example.com', type: 'A' },
				{ id: 'record-id2', name: 'home.example.com', type: 'A' },
			],
		});

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('More than one matching record found!');
	});

	it('responds with 400 when no records are found', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords.mockResolvedValueOnce({ result: [] });

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('No record found! You must first manually create the record.');
	});

	it('responds with 500 for an unforeseen internal server error', async () => {
		mockListZones.mockImplementationOnce(() => {
			throw new Error('Unexpected Error');
		});

		const response = await worker.fetch(new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Internal Server Error');
	});

	it('responds with 200 on valid IPv6 update', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords.mockResolvedValueOnce({ result: [{ id: 'record-id', name: 'home.example.com', type: 'AAAA' }] });
		mockUpdateRecord.mockResolvedValueOnce({});

		const response = await worker.fetch(new Request('http://example.com/update?ip=2001:0db8:85a3:0000:0000:8a2e:0370:7334&hostname=home.example.com', {
			headers: {
				Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
			},
		}));
		expect(response.status).toBe(200);
	});

	it('responds with 200 on valid dual-stack update with ip6 parameter', async () => {
		mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id' }] });
		mockListRecords
			.mockResolvedValueOnce({ result: [{ id: 'record-id-a', name: 'home.example.com', type: 'A' }] })
			.mockResolvedValueOnce({ result: [{ id: 'record-id-aaaa', name: 'home.example.com', type: 'AAAA' }] });
		mockUpdateRecord.mockResolvedValue({});

		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&ip6=2001:0db8:85a3:0000:0000:8a2e:0370:7334&hostname=home.example.com', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
	});

	it('responds with 422 when ip6 parameter is not a valid IPv6 address', async () => {
		const response = await worker.fetch(
			new Request('http://example.com/update?ip=192.0.2.1&ip6=not-an-ipv6&hostname=home.example.com', {
				headers: {
					Authorization: 'Basic ' + btoa('email@example.com:validtoken'),
				},
			}),
		);
		expect(response.status).toBe(422);
		expect(await response.text()).toBe('The "ip6" parameter must be a valid IPv6 address.');
	});
	describe('failure logging', () => {
		const auth = { Authorization: 'Basic ' + btoa('email@example.com:validtoken') };

		beforeEach(() => {
			// Drop any queued once-implementations left over from earlier tests.
			for (const mock of [mockListZones, mockListRecords, mockUpdateRecord]) {
				mock.mockReset();
			}
		});

		it('logs a structured error without credentials on client errors', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockListZones.mockResolvedValueOnce({ result: [] });

			const response = await worker.fetch(
				new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', { headers: auth }),
			);

			expect(response.status).toBe(400);
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const entry = errorSpy.mock.calls[0][0];
			expect(entry).toMatchObject({
				message: 'DDNS update failed',
				responseStatus: 400,
				hostname: 'home.example.com',
				ip: '192.0.2.1',
				error: { name: 'HttpError', message: 'No zones found! The API Token must have access to at least one zone.' },
			});
			expect(JSON.stringify(entry)).not.toContain('validtoken');
			errorSpy.mockRestore();
		});

		it('logs the underlying Cloudflare API error when the token is rejected', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockListZones.mockRejectedValueOnce(
				Object.assign(new Error('403 Authentication error'), {
					name: 'PermissionDeniedError',
					status: 403,
					errors: [{ code: 10000, message: 'Authentication error' }],
				}),
			);

			const response = await worker.fetch(
				new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', { headers: auth }),
			);

			expect(response.status).toBe(401);
			expect(errorSpy.mock.calls[0][0]).toMatchObject({
				responseStatus: 401,
				error: { name: 'HttpError', message: 'The API Token is invalid, expired, or lacks Zone:Read permission.' },
				cause: {
					name: 'PermissionDeniedError',
					apiStatus: 403,
					apiErrors: [{ code: 10000, message: 'Authentication error' }],
				},
			});
			expect(JSON.stringify(errorSpy.mock.calls[0][0])).not.toContain('validtoken');
			errorSpy.mockRestore();
		});

		it('logs Cloudflare API status and errors on unexpected SDK failures', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const apiError = Object.assign(new Error('500 Internal error'), {
				name: 'InternalServerError',
				status: 500,
				errors: [{ code: 10001, message: 'Internal error' }],
			});
			mockListZones.mockResolvedValueOnce({ result: [{ id: 'zone-id', name: 'example.com' }] });
			mockListRecords.mockRejectedValueOnce(apiError);

			const response = await worker.fetch(
				new Request('http://example.com/update?ip=192.0.2.1&hostname=home.example.com', { headers: auth }),
			);

			expect(response.status).toBe(500);
			expect(await response.text()).toBe('Internal Server Error');
			expect(errorSpy.mock.calls[0][0]).toMatchObject({
				responseStatus: 500,
				error: {
					name: 'InternalServerError',
					apiStatus: 500,
					apiErrors: [{ code: 10001, message: 'Internal error' }],
				},
			});
			errorSpy.mockRestore();
		});
	});
});
