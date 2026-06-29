import {
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from '../opportunities/opportunity-types';

export interface OpportunityStrategy {
  findCandidates(request: FindOpportunitiesRequest): CandidateRoute[];
}
