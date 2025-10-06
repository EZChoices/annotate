(function(global){
  function selectGoldClips(manifest){
    if(!manifest || !Array.isArray(manifest.items)){
      return [];
    }
    return manifest.items.slice(0, 3).map((item, index)=>({
      clipId: item.id || `clip-${index + 1}`,
      title: item.title || item.clip_title || `Clip ${index + 1}`,
      language: item.language || 'unknown'
    }));
  }

  function computeMetrics(clips, context){
    const totalGoldClips = Array.isArray(clips) ? clips.length : 0;
    return {
      totalGoldClips,
      reviewedClips: Math.min(totalGoldClips, 2),
      accuracyScore: 0.87,
      consistencyScore: 0.91,
      notes: 'Placeholder metrics generated for QA preview.',
      context: context || {}
    };
  }

  function generateReport(options){
    const opts = options || {};
    const manifest = opts.manifest || null;
    const annotations = opts.annotations || {};
    const clips = selectGoldClips(manifest);
    const metrics = computeMetrics(clips, { annotations });

    return {
      generatedAt: new Date().toISOString(),
      annotator: opts.annotator || 'anonymous',
      summary: {
        totalGoldClips: metrics.totalGoldClips,
        reviewedClips: metrics.reviewedClips,
        accuracyScore: metrics.accuracyScore,
        consistencyScore: metrics.consistencyScore,
        notes: metrics.notes
      },
      clips: clips.map((clip, index)=>({
        ...clip,
        qaStatus: index % 2 === 0 ? 'Pass' : 'Review',
        comment: 'Placeholder evaluation for development.'
      }))
    };
  }

  global.QAMetrics = {
    selectGoldClips,
    computeMetrics,
    generateReport
  };
})(typeof window !== 'undefined' ? window : globalThis);
