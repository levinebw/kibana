/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  Logger,
  CoreStart,
  ElasticsearchClient,
  SavedObjectsClientContract,
} from 'src/core/server';
import { SearchRequest } from '@elastic/elasticsearch/api/types';
import { getTrustedAppsList } from '../../endpoint/routes/trusted_apps/service';
import { AgentService, AgentPolicyServiceInterface } from '../../../../fleet/server';
import { ExceptionListClient } from '../../../../lists/server';
import { EndpointAppContextService } from '../../endpoint/endpoint_app_context_services';
import { exceptionListItemToEndpointEntry } from './helpers';
import { TelemetryEvent, ESLicense, ESClusterInfo, GetEndpointListResponse } from './types';

export class TelemetryReceiver {
  private readonly logger: Logger;
  private agentService?: AgentService;
  private agentPolicyService?: AgentPolicyServiceInterface;
  private esClient?: ElasticsearchClient;
  private exceptionListClient?: ExceptionListClient;
  private soClient?: SavedObjectsClientContract;
  private readonly max_records = 10_000;
  private maxQueueSize = 100;

  constructor(logger: Logger) {
    this.logger = logger.get('telemetry_events');
  }

  public async start(
    core?: CoreStart,
    endpointContextService?: EndpointAppContextService,
    exceptionListClient?: ExceptionListClient
  ) {
    this.agentService = endpointContextService?.getAgentService();
    this.agentPolicyService = endpointContextService?.getAgentPolicyService();
    this.esClient = core?.elasticsearch.client.asInternalUser;
    this.exceptionListClient = exceptionListClient;
    this.soClient = (core?.savedObjects.createInternalRepository() as unknown) as SavedObjectsClientContract;
  }

  public async fetchFleetAgents() {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve fleet policy responses');
    }

    return this.agentService?.listAgents(this.esClient, {
      perPage: this.max_records,
      showInactive: true,
      sortField: 'enrolled_at',
      sortOrder: 'desc',
    });
  }

  public async fetchClusterInfo(): Promise<ESClusterInfo> {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve cluster infomation');
    }

    return this.getClusterInfo(this.esClient);
  }

  public async fetchEndpointPolicyResponses(executeFrom: string, executeTo: string) {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error(
        'elasticsearch client is unavailable: cannot retrieve elastic endpoint policy responses'
      );
    }

    const query: SearchRequest = {
      expand_wildcards: 'open,hidden',
      index: `.ds-metrics-endpoint.policy*`,
      ignore_unavailable: false,
      size: 0, // no query results required - only aggregation quantity
      body: {
        query: {
          range: {
            '@timestamp': {
              gte: executeFrom,
              lt: executeTo,
            },
          },
        },
        aggs: {
          policy_responses: {
            terms: {
              size: this.max_records,
              field: 'Endpoint.policy.applied.id',
            },
            aggs: {
              latest_response: {
                top_hits: {
                  size: 1,
                  sort: [
                    {
                      '@timestamp': {
                        order: 'desc' as const,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };

    return this.esClient.search(query);
  }

  public async fetchEndpointMetrics(executeFrom: string, executeTo: string) {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve elastic endpoint metrics');
    }

    const query: SearchRequest = {
      expand_wildcards: 'open,hidden',
      index: `.ds-metrics-endpoint.metrics-*`,
      ignore_unavailable: false,
      size: 0, // no query results required - only aggregation quantity
      body: {
        query: {
          range: {
            '@timestamp': {
              gte: executeFrom,
              lt: executeTo,
            },
          },
        },
        aggs: {
          endpoint_agents: {
            terms: {
              field: 'agent.id',
              size: this.max_records,
            },
            aggs: {
              latest_metrics: {
                top_hits: {
                  size: 1,
                  sort: [
                    {
                      '@timestamp': {
                        order: 'desc' as const,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };

    return this.esClient.search(query);
  }

  public async fetchDiagnosticAlerts(executeFrom: string, executeTo: string) {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve diagnostic alerts');
    }

    const query = {
      expand_wildcards: 'open,hidden',
      index: '.logs-endpoint.diagnostic.collection-*',
      ignore_unavailable: true,
      size: this.maxQueueSize,
      body: {
        query: {
          range: {
            'event.ingested': {
              gte: executeFrom,
              lt: executeTo,
            },
          },
        },
        sort: [
          {
            'event.ingested': {
              order: 'desc' as const,
            },
          },
        ],
      },
    };

    return (await this.esClient.search<TelemetryEvent>(query)).body;
  }

  /**
   * Get the cluster info from the connected cluster.
   * Copied from:
   * src/plugins/telemetry/server/telemetry_collection/get_cluster_info.ts
   * This is the equivalent to GET /
   */
  private async getClusterInfo(esClient: ElasticsearchClient) {
    const { body } = await esClient.info();
    return body;
  }

  public async fetchLicenseInfo(): Promise<ESLicense | undefined> {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve license information');
    }

    try {
      const ret = await this.getLicense(this.esClient, true);
      return ret.license;
    } catch (err) {
      this.logger.debug(`failed retrieving license: ${err}`);
      return undefined;
    }
  }

  private async getLicense(
    esClient: ElasticsearchClient,
    local: boolean
  ): Promise<{ license: ESLicense }> {
    return (
      await esClient.transport.request({
        method: 'GET',
        path: '/_license',
        querystring: {
          local,
          // For versions >= 7.6 and < 8.0, this flag is needed otherwise 'platinum' is returned for 'enterprise' license.
          accept_enterprise: 'true',
        },
      })
    ).body as Promise<{ license: ESLicense }>; // Note: We have to as cast since transport.request doesn't have generics
  }

  public copyLicenseFields(lic: ESLicense) {
    return {
      uid: lic.uid,
      status: lic.status,
      type: lic.type,
      ...(lic.issued_to ? { issued_to: lic.issued_to } : {}),
      ...(lic.issuer ? { issuer: lic.issuer } : {}),
    };
  }

  public async fetchPolicyConfigs(id: string) {
    if (this.soClient === undefined || this.soClient === null) {
      throw Error(
        'saved object client is unavailable: cannot retrieve endpoint policy configurations'
      );
    }

    return this.agentPolicyService?.get(this.soClient, id);
  }

  public async fetchTrustedApplications() {
    if (this?.exceptionListClient === undefined || this?.exceptionListClient === null) {
      throw Error('exception list client is unavailable: cannot retrieve trusted applications');
    }

    return getTrustedAppsList(this.exceptionListClient, { page: 1, per_page: 10_000 });
  }

  public async fetchEndpointList(listId: string): Promise<GetEndpointListResponse> {
    if (this?.exceptionListClient === undefined || this?.exceptionListClient === null) {
      throw Error('exception list client is unavailable: could not retrieve trusted applications');
    }

    // Ensure list is created if it does not exist
    await this.exceptionListClient.createTrustedAppsList();

    const results = await this.exceptionListClient.findExceptionListItem({
      listId,
      page: 1,
      perPage: this.max_records,
      filter: undefined,
      namespaceType: 'agnostic',
      sortField: 'name',
      sortOrder: 'asc',
    });

    return {
      data: results?.data.map(exceptionListItemToEndpointEntry) ?? [],
      total: results?.total ?? 0,
      page: results?.page ?? 1,
      per_page: results?.per_page ?? this.max_records,
    };
  }
}
