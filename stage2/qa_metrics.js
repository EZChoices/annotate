(function(global){
  function normalizeClip(item, index){
    const clipId =
      item && (item.clipId || item.asset_id || item.id || item.clip_id);
    const language =
      (item && (item.language || item.language_hint || item.locale)) || 'unknown';
    return {
      clipId: clipId || `clip-${index + 1}`,
      title:
        (item && (item.title || item.clip_title || item.asset_id || item.clipId)) ||
        `Clip ${index + 1}`,
      language,
      isGold: !!(item && (item.is_gold || item.isGold)),
      durationSec:
        item && item.durationSec != null && Number(item.durationSec) > 0
          ? Number(item.durationSec)
          : item && item.media && Number(item.media.duration_sec) > 0
            ? Number(item.media.duration_sec)
            : null
    };
  }

  function selectGoldClips(manifest){
    if(!manifest || !Array.isArray(manifest.items)){
      return [];
    }
    const goldClips = manifest.items.filter(item=> item && item.is_gold === true);
    const selection = goldClips.length ? goldClips : manifest.items.slice(0, 3);
    return selection.map(normalizeClip);
  }

  function clampScore(value){
    if(!Number.isFinite(value)) return 0;
    if(value < 0) return 0;
    if(value > 1) return 1;
    return Number(value.toFixed(2));
  }

  function computeMetrics(clips, context){
    const totalGoldClips = Array.isArray(clips) ? clips.length : 0;
    const annotations = (context && context.annotations) || {};
    const lint = annotations.lint || {};
    const errorCount = Array.isArray(lint.errors) ? lint.errors.length : 0;
    const warningCount = Array.isArray(lint.warnings) ? lint.warnings.length : 0;
    const translationGaps = Array.isArray(lint.translationMissingIndices)
      ? lint.translationMissingIndices.length
      : 0;
    const codeSwitchIssues = Array.isArray(lint.codeSwitchIssues)
      ? lint.codeSwitchIssues.length
      : 0;

    const accuracyPenalty = Math.min(1, errorCount * 0.25 + translationGaps * 0.12);
    const consistencyPenalty = Math.min(1, warningCount * 0.12 + codeSwitchIssues * 0.18);

    const summaryBits = [];
    if(errorCount){
      summaryBits.push(`${errorCount} blocking ${errorCount === 1 ? 'issue' : 'issues'}`);
    }
    if(warningCount){
      summaryBits.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
    }
    if(translationGaps){
      summaryBits.push(`${translationGaps} translation gap${translationGaps === 1 ? '' : 's'}`);
    }
    if(codeSwitchIssues){
      summaryBits.push(`${codeSwitchIssues} code-switch flag${codeSwitchIssues === 1 ? '' : 's'}`);
    }

    const hasSubmission = !!(annotations && annotations.clip);
    const reviewedClips = hasSubmission
      ? Math.min(totalGoldClips, 1)
      : 0;

    return {
      totalGoldClips,
      reviewedClips,
      accuracyScore: clampScore(1 - accuracyPenalty),
      consistencyScore: clampScore(1 - consistencyPenalty),
      notes: summaryBits.length
        ? `Detected ${summaryBits.join(', ')}.`
        : 'No blocking QA findings on the latest submission.',
      breakdown: {
        errorCount,
        warningCount,
        translationGaps,
        codeSwitchIssues
      },
      context: context || {}
    };
  }

  function buildClipComment(clip, metrics, options){
    const breakdown = metrics && metrics.breakdown ? metrics.breakdown : {};
    const currentClipId = options && options.currentClipId;
    const latestIssues = [];
    const lint = options && options.annotations && options.annotations.lint;
    if(breakdown.errorCount){
      latestIssues.push(`${breakdown.errorCount} blocking ${breakdown.errorCount === 1 ? 'issue' : 'issues'}`);
    }
    if(breakdown.warningCount){
      latestIssues.push(`${breakdown.warningCount} warning${breakdown.warningCount === 1 ? '' : 's'}`);
    }
    if(breakdown.translationGaps){
      latestIssues.push(`${breakdown.translationGaps} translation gap${breakdown.translationGaps === 1 ? '' : 's'}`);
    }
    if(breakdown.codeSwitchIssues){
      latestIssues.push(`${breakdown.codeSwitchIssues} code-switch flag${breakdown.codeSwitchIssues === 1 ? '' : 's'}`);
    }

    const hasLint = lint && (
      Array.isArray(lint.errors) ||
      Array.isArray(lint.warnings) ||
      Array.isArray(lint.translationMissingIndices) ||
      Array.isArray(lint.codeSwitchIssues)
    );
    const isLatest = currentClipId && clip.clipId === currentClipId;

    if(isLatest && hasLint){
      if(breakdown.errorCount){
        return {
          qaStatus: 'Fail',
          comment: `Latest submission blocked: ${latestIssues.join(', ')}.`
        };
      }
      if(breakdown.warningCount || breakdown.translationGaps || breakdown.codeSwitchIssues){
        return {
          qaStatus: 'Review',
          comment: `Requires follow-up: ${latestIssues.join(', ')}.`
        };
      }
      return {
        qaStatus: 'Pass',
        comment: 'Latest submission cleared automated QA checks.'
      };
    }

    if(clip.isGold){
      return {
        qaStatus: 'Pending',
        comment: 'Gold clip queued for verification.'
      };
    }

    return {
      qaStatus: 'Info',
      comment: 'Awaiting gold evaluation.'
    };
  }

  function generateReport(options){
    const opts = options || {};
    const manifest = opts.manifest || null;
    const annotations = opts.annotations || {};
    const clips = selectGoldClips(manifest);
    const metrics = computeMetrics(clips, { annotations });
    const currentClipId = annotations && annotations.clip && (
      annotations.clip.asset_id ||
      annotations.clip.id ||
      annotations.clip.clip_id ||
      annotations.clip.clipId
    );

    return {
      generatedAt: new Date().toISOString(),
      annotator: opts.annotator || 'anonymous',
      summary: {
        totalGoldClips: metrics.totalGoldClips,
        reviewedClips: metrics.reviewedClips,
        accuracyScore: metrics.accuracyScore,
        consistencyScore: metrics.consistencyScore,
        notes: metrics.notes,
        breakdown: metrics.breakdown
      },
      clips: clips.map((clip, index)=>{
        const base = normalizeClip(clip, index);
        const status = buildClipComment(base, metrics, {
          annotations,
          currentClipId
        });
        return {
          ...base,
          ...status
        };
      })
    };
  }

  global.QAMetrics = {
    selectGoldClips,
    computeMetrics,
    generateReport
  };
})(typeof window !== 'undefined' ? window : globalThis);
