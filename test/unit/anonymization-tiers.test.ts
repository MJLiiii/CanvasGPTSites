// Ports the endpoint-gating cases of upstream tests/security/test_anonymization_endpoints.py and test_anonymization_shapes.py.
import { describe, expect, it } from 'vitest';

import { SELF_ONLY_ENDPOINTS, dataTypeForPath, maxTier, tierForPath } from '../../src/core/anonymization-tiers';
import type { AnonymizationTier } from '../../src/types';

/** Upstream's `_should_anonymize_endpoint`: a boolean view over the tier. */
function isAnonymized(path: string): boolean {
  return tierForPath(path) !== 'none';
}

describe('student-data endpoints are gated even when nested under /courses', () => {
  it.each([
    '/courses/123/enrollments',
    '/sections/45/enrollments',
    '/courses/123/assignments/456/submissions',
    '/courses/123/assignments/456/submissions/789',
    '/courses/123/students/submissions',
    '/courses/123/analytics/student_summaries',
    '/courses/123/analytics/users/77/activity',
    '/courses/123/users',
    '/courses/123/users/456',
    '/groups/55/users',
    '/courses/123/discussion_topics/9/entries',
    '/courses/123/discussion_topics/9/entries/1/replies',
    '/courses/123/discussion_topics/9/view',
    '/courses/123/discussion_topics/9/entry_list',
  ])('anonymizes %s', (path) => {
    expect(isAnonymized(path)).toBe(true);
  });

  it.each([
    '/courses',
    '/courses/123',
    '/courses/123/modules',
    '/courses/123/modules/5/items',
    '/courses/123/assignments',
    '/courses/123/assignments/456',
    '/courses/123/rubrics/12',
    '/accounts/1/terms',
    // Group listings carry group names, not student names; membership goes
    // through /groups/{id}/users, which the users rule covers.
    '/courses/123/groups',
    // Topic listings (incl. announcements) are typically instructor-authored.
    '/courses/123/discussion_topics',
  ])('does not anonymize %s', (path) => {
    expect(isAnonymized(path)).toBe(false);
  });

  it.each([
    '/api/quiz/v1/courses/123/enrollments',
    '/api/quiz/v1/courses/123/users',
    '/api/quiz/v1/courses/123/assignments/456/submissions',
    '/api/quiz/v1/courses/123/analytics/student_summaries',
  ])('a quiz-root prefix does not bypass sensitive-segment matching: %s', (path) => {
    expect(isAnonymized(path)).toBe(true);
  });

  it.each(['/api/quiz/v1/courses/123/modules', '/api/quiz/v1/courses/123/assignments'])(
    'a quiz-root prefix does not gate %s',
    (path) => {
      expect(isAnonymized(path)).toBe(false);
    },
  );

  it('is case-insensitive', () => {
    expect(isAnonymized('/COURSES/123/ENROLLMENTS')).toBe(true);
  });

  it('strips the query string before matching', () => {
    expect(isAnonymized('/courses/123/enrollments?per_page=100')).toBe(true);
    expect(isAnonymized('/courses/123/modules?search_term=users')).toBe(false);
  });
});

describe('tier mapping', () => {
  it.each([
    '/conversations',
    '/conversations/123',
    '/conversations?scope=unread',
    '/CONVERSATIONS',
    '/conversations/123/add_message',
  ])('%s is the free_text tier', (path) => {
    expect(tierForPath(path)).toBe('free_text');
  });

  it.each([
    '/courses/123/pages',
    '/courses/123/pages/syllabus',
    '/courses/123/pages/intro?include[]=body',
    '/groups/55/pages',
    // Page slugs are user-controlled: a page named "users" must not escalate
    // the tier to full.
    '/courses/123/pages/users',
    '/courses/123/pages/submissions',
    '/courses/123/pages/analytics',
    // The front page returns the same last_edited_by block but its path has
    // no 'pages' segment.
    '/courses/123/front_page',
    '/groups/55/front_page',
  ])('%s is the identity tier', (path) => {
    expect(tierForPath(path)).toBe('identity');
  });

  it.each([
    '/courses/123/users',
    '/courses/123/enrollments',
    '/courses/123/assignments/1/submissions',
    '/courses/123/analytics/student_summaries',
    '/courses/123/discussion_topics/9/view',
  ])('%s is the full tier', (path) => {
    expect(tierForPath(path)).toBe('full');
  });

  it.each(['/courses', '/courses/123/modules', '/courses/123/assignments', '/accounts/1/terms', '/users/self/profile'])(
    '%s is the none tier',
    (path) => {
      expect(tierForPath(path)).toBe('none');
    },
  );

  it('full wins over the partial tiers', () => {
    expect(tierForPath('/courses/123/users/9/pages')).toBe('full');
  });

  it('a discussion content word without a discussion_topics segment is not gated', () => {
    expect(tierForPath('/courses/123/modules/5/view')).toBe('none');
    expect(tierForPath('/courses/123/discussion_topics/9')).toBe('none');
  });

  it('a slug after "pages" never counts as a route keyword', () => {
    expect(tierForPath('/courses/1/pages/conversations')).toBe('identity');
    expect(tierForPath('/courses/1/pages/users/revisions')).toBe('identity');
    // ...but the segment after the slug is a route keyword again.
    expect(tierForPath('/courses/1/pages/intro/users')).toBe('full');
  });
});

describe('caller-only endpoints are exempt by exact path only', () => {
  it.each([
    '/users/self',
    '/users/self/profile',
    'users/self/profile',
    '/users/self/profile?include[]=x',
    '/USERS/SELF/PROFILE',
    '/users/self/profile/',
  ])('%s is exempt', (path) => {
    expect(isAnonymized(path)).toBe(false);
  });

  it.each([
    // Other people, reached through the caller's own /users/self namespace.
    '/users/self/observees',
    // Looks self-only, but include[]=observed_users returns OTHER students and
    // the gate cannot see request parameters.
    '/users/self/enrollments',
    '/users/self/observees/55',
    '/users/self/courses/123/users',
    '/users/self/enrollments/999',
    '/users/self/profile/extra',
    // Rosters.
    '/courses/123/enrollments',
    '/courses/123/users',
    '/sections/45/enrollments',
    // Somebody else's profile.
    '/users/456/profile',
    '/users/456',
    '/users/self_service/profile',
    // A course literally slugged "self".
    '/courses/self/users',
    // Prefix games.
    '/api/v1/users/self/profile',
    '/api/quiz/v1/users/self/profile',
    '/accounts/1/users/self/profile',
  ])('%s is still anonymized', (path) => {
    expect(isAnonymized(path)).toBe(true);
  });

  it('the allowlist is exactly two paths', () => {
    // Growing this set is a FERPA decision, not a refactor.
    expect([...SELF_ONLY_ENDPOINTS].sort()).toEqual(['users/self', 'users/self/profile']);
  });
});

describe('the /submissions/self carve-out', () => {
  it.each([
    '/courses/123/assignments/456/submissions/self',
    '/courses/123/assignments/456/submissions/self?include[]=submission_comments',
    '/sections/45/assignments/456/submissions/self',
  ])('%s is the caller’s own submission and is not anonymized', (path) => {
    expect(isAnonymized(path)).toBe(false);
  });

  it.each([
    '/courses/123/assignments/456/submissions/123',
    '/courses/123/assignments/456/submissions',
    '/courses/123/assignments/456/submissions/selfie',
    '/courses/123/assignments/456/submissions/self_review',
    '/courses/123/students/submissions',
  ])('%s is still anonymized', (path) => {
    expect(isAnonymized(path)).toBe(true);
  });

  it('does not disable other sensitive segments in the same path', () => {
    expect(isAnonymized('/courses/123/users/9/assignments/456/submissions/self')).toBe(true);
    expect(tierForPath('/courses/123/discussion_topics/9/entries/submissions/self')).toBe('full');
  });

  it('only "self" directly after "submissions" counts', () => {
    expect(tierForPath('/courses/123/assignments/456/submissions/789/self')).toBe('full');
    expect(tierForPath('/courses/self/assignments/456/submissions')).toBe('full');
  });

  it('removes only the submissions segment, so a later tier still applies', () => {
    expect(tierForPath('/conversations/submissions/self')).toBe('free_text');
    expect(tierForPath('/courses/1/front_page/submissions/self')).toBe('identity');
  });
});

describe('percent-encoded route keywords', () => {
  // Canvas decodes the path before routing, so an encoded keyword reaches the
  // same roster as the literal one. Upstream matches literal segments only.
  it.each([
    '/courses/1/%75sers',
    '/courses/1/%55SERS',
    '/courses/1/%75%73%65%72%73/9',
    '/courses/1/assignments/2/%73ubmissions',
    '/courses/1/%65nrollments',
    '/courses/1/discussion_topics/9/%76iew',
    '/courses/1/users%2F9',
    '/courses/1/users%2f%ff',
  ])('%s is the full tier', (path) => {
    expect(tierForPath(path)).toBe('full');
  });

  it('an encoded keyword raises the lower tiers too', () => {
    expect(tierForPath('/%63onversations')).toBe('free_text');
    expect(tierForPath('/courses/1/front%5Fpage')).toBe('identity');
    expect(tierForPath('/courses/1/%70ages')).toBe('identity');
  });

  it('decoding never lowers the tier chosen from the literal segments', () => {
    // Literal reading: a roster of user "%73elf". Decoded reading: the caller.
    expect(tierForPath('/users/%73elf')).toBe('full');
    expect(tierForPath('/users/%73elf/profile')).toBe('full');
    // Literal reading: someone's submission. Decoded reading: the caller's own.
    expect(tierForPath('/courses/1/assignments/2/submissions/%73elf')).toBe('full');
    // Literal reading: a users roster under a route named "%70ages".
    expect(tierForPath('/courses/1/%70ages/users')).toBe('full');
  });

  it('an encoded slash in a page slug is read as a separator', () => {
    expect(tierForPath('/courses/1/pages/a%2Fusers')).toBe('full');
  });

  it('ordinary encoded slugs and malformed escapes are unaffected', () => {
    expect(tierForPath('/courses/1/pages/caf%C3%A9')).toBe('identity');
    expect(tierForPath('/courses/1/pages/100%25')).toBe('identity');
    expect(tierForPath('/courses/1/%zz/modules')).toBe('none');
    expect(tierForPath('/courses/sis_course_id%3AABC/modules')).toBe('none');
    // Double encoding decodes once, to a segment that is not a keyword.
    expect(tierForPath('/courses/1/%2575sers')).toBe('none');
  });
});

describe('dataTypeForPath', () => {
  it('maps enrollments to the users type', () => {
    expect(dataTypeForPath('/courses/123/enrollments')).toBe('users');
  });

  it('maps the discussion view to the discussions type', () => {
    expect(dataTypeForPath('/courses/123/discussion_topics/9/view')).toBe('discussions');
    expect(dataTypeForPath('/courses/123/discussion_entries/4')).toBe('discussions');
  });

  it('is segment-aware', () => {
    expect(dataTypeForPath('/courses/1/assignments/2/submissions')).toBe('submissions');
    expect(dataTypeForPath('/courses/1/assignments/2/submissions?include[]=user')).toBe('submissions');
    expect(dataTypeForPath('/courses/1/pages/submissions')).toBe('general');
    expect(dataTypeForPath('/courses/1/pages/users')).toBe('general');
    expect(dataTypeForPath('/courses/1/assignments')).toBe('assignments');
  });

  it('checks users first, then discussions, submissions, assignments', () => {
    expect(dataTypeForPath('/courses/1/users/9/assignments/2/submissions')).toBe('users');
    expect(dataTypeForPath('/courses/1/discussion_topics/3/submissions')).toBe('discussions');
    expect(dataTypeForPath('/courses/1/modules')).toBe('general');
    expect(dataTypeForPath('/COURSES/1/SUBMISSIONS')).toBe('submissions');
  });
});

describe('maxTier', () => {
  const tiers: AnonymizationTier[] = ['none', 'identity', 'free_text', 'full'];

  it('never returns a tier weaker than either argument', () => {
    // What each tier scrubs: [display names, free text, typed refinements].
    const covers: Record<AnonymizationTier, [boolean, boolean, boolean]> = {
      none: [false, false, false],
      identity: [true, false, false],
      free_text: [false, true, false],
      full: [true, true, true],
    };
    for (const a of tiers) {
      for (const b of tiers) {
        const joined = covers[maxTier(a, b)];
        covers[a].forEach((needed, i) => expect(joined[i] || !needed).toBe(true));
        covers[b].forEach((needed, i) => expect(joined[i] || !needed).toBe(true));
      }
    }
  });

  it('is commutative and idempotent', () => {
    for (const a of tiers) {
      expect(maxTier(a, a)).toBe(a);
      for (const b of tiers) {
        expect(maxTier(a, b)).toBe(maxTier(b, a));
      }
    }
  });

  it('leaves a tier alone when the other side is none', () => {
    expect(maxTier('identity', 'none')).toBe('identity');
    expect(maxTier('none', 'free_text')).toBe('free_text');
    expect(maxTier('none', 'none')).toBe('none');
  });

  it('combines the two partial tiers into full', () => {
    expect(maxTier('identity', 'free_text')).toBe('full');
  });

  it('full absorbs everything', () => {
    for (const tier of tiers) {
      expect(maxTier('full', tier)).toBe('full');
    }
  });
});
