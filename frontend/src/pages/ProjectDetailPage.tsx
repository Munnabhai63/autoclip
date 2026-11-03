import { trackExperience } from '../analytics/experience'
import { workflow } from '../analytics/observer'
import { t } from '../i18n'
import { useTranslation } from 'react-i18next'
import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { message } from 'antd'
import dayjs from 'dayjs'
import { useProjectStore, Collection } from '../store/useProjectStore'
import { projectApi, speechApi } from '../services/api'
import StudioResults from '../features/studio/StudioResults'
import { needsImportConfirmation } from '../features/studio/importRouting'
import { studioApi, errorText } from '../features/studio/api'
import LlmKeyFailureEmpty from '../components/LlmKeyFailureEmpty'
import { classifyLlmKeyFailure } from '../utils/llmFailure'
import { classifyTimelineEmpty } from '../utils/timelineFailure'
import SubtitleFailureEmpty from '../components/SubtitleFailureEmpty'
import { classifySubtitleFailure, type SubtitleFailureKind } from '../utils/subtitleFailure'
import ClipCard from '../components/ClipCard'
import CollectionCard from '../components/CollectionCard'
import CollectionPreviewModal from '../components/CollectionPreviewModal'
import CreateCollectionModal from '../components/CreateCollectionModal'
import { useCollectionVideoDownload } from '../hooks/useCollectionVideoDownload'
import { ProjectTaskManager } from '../components/ProjectTaskManager'
import FeedbackDialog from '../components/FeedbackDialog'
import { Btn, Icon, parseTimecode, fmtDuration } from '../ui'
import { openExternalLink } from '../utils/externalLinks'

const ProjectDetailPage: React.FC = () => {
  useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const {
    projects,
    currentProject,
    setCurrentProject,
    upsertProject,
    updateCollection,
    addCollection,
    deleteCollection,
    removeClipFromCollection,
    reorderCollectionClips,
    addClipToCollection
  } = useProjectStore()

  const activeProject = (currentProject?.id === id ? currentProject : projects.find((p) => p.id === id)) || null
  const [loading, setLoading] = useState(!activeProject)
  const [error, setError] = useState('')
  const loadVersion = useRef(0)
  const exampleView = useRef('')
  const exampleVisible = !loading && !error && activeProject?.id === id && !!(activeProject?.settings?.example || activeProject?.processing_config?.example)
  useEffect(() => {
    if (!exampleVisible || !id) { exampleView.current = ''; return }
    if (exampleView.current === id) return
    exampleView.current = id
    trackExperience('example_project_viewed', { ...workflow.context(id), material_origin: 'sample' })
  }, [exampleVisible, id])
  const [statusLoading, setStatusLoading] = useState(false)
  const [showCreateCollection, setShowCreateCollection] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [showCollectionDetail, setShowCollectionDetail] = useState(false)
  const [selectedCollection, setSelectedCollection] = useState<Collection | null>(null)
  const { generateAndDownloadCollectionVideo } = useCollectionVideoDownload()

  useEffect(() => {
    if (!id) return
    if (activeProject && currentProject?.id !== id) {
      setCurrentProject(activeProject)
    }
    loadProject()
    loadProcessingStatus()
    return () => { loadVersion.current += 1 }
  }, [id])

  const timelineEmpty = classifyTimelineEmpty(activeProject?.error_message, activeProject?.error_code)
  const subtitleKind = timelineEmpty
    ? null
    : classifySubtitleFailure(activeProject?.error_message, activeProject?.error_code)
  const [refinedSubtitle, setRefinedSubtitle] = useState<{ id?: string; kind: SubtitleFailureKind } | null>(null)
  useEffect(() => {
    // 1.3.2 只留下一句「本地转写没有生成结果」。升级后按这台机器现在的 Whisper 状态说清楚下一步。
    if (subtitleKind !== 'subtitle_unknown' || !activeProject?.id) return
    const projectId = activeProject.id
    let cancelled = false
    speechApi.getRuntimeStatus()
      .then((rt) => {
        if (cancelled) return
        const kind: SubtitleFailureKind | null = rt.status === 'error'
          ? 'whisper_install_failed'
          : rt.status === 'installed'
            ? 'transcription_empty'
            : rt.status === 'not_installed'
              ? 'whisper_not_installed'
              : null
        if (kind) setRefinedSubtitle({ id: projectId, kind })
      })
      .catch(() => { /* 问不到状态时保留通用说明 */ })
    return () => { cancelled = true }
  }, [subtitleKind, activeProject?.id])
  const refinedKind = refinedSubtitle && refinedSubtitle.id === activeProject?.id ? refinedSubtitle.kind : null
  const shownSubtitleKind = subtitleKind === 'subtitle_unknown'
    ? (refinedKind || subtitleKind)
    : subtitleKind

  const loadProject = async () => {
    if (!id) return
    const version = ++loadVersion.current
    setError('')
    const hasCached = activeProject?.id === id || projects.some((p) => p.id === id)
    if (!hasCached) setLoading(true)
    try {
      const project = await projectApi.getProject(id)
      if (version !== loadVersion.current) return
      setCurrentProject(project)
      upsertProject(project)
      setLoading(false)

      if (project.status === 'completed') {
        try {
          const [clips, collections] = await Promise.all([
            projectApi.getClips(id),
            projectApi.getCollections(id)
          ])
          if (version !== loadVersion.current) return
          const projectWithData = { ...project, clips: clips || [], collections: collections || [] }
          setCurrentProject(projectWithData)
          upsertProject(projectWithData)
        } catch (err) {
          if (version !== loadVersion.current) return
          console.error('Failed to load clips/collections:', err)
        }
      }
    } catch (err) {
      if (version !== loadVersion.current) return
      if (!hasCached) setError(errorText(err))
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }

  const loadProcessingStatus = async () => {
    if (!id) return
    setStatusLoading(true)
    try {
      await projectApi.getProcessingStatus(id)
    } catch (err) {
      console.error('Failed to load processing status:', err)
    } finally {
      setStatusLoading(false)
    }
  }

  const handleStartProcessing = async () => {
    if (!id) return
    try {
      await projectApi.startProcessing(id)
      message.success(t("开始处理"))
      loadProcessingStatus()
    } catch (err) {
      console.error('Failed to start processing:', err)
      message.error(t("启动处理失败"))
    }
  }

  const handleRetryProcessing = async () => {
    if (!id) return
    setStatusLoading(true)
    try {
      await projectApi.retryProcessing(id)
      message.success(t("已重新开始处理"))
      loadProcessingStatus()
      await loadProject()
    } catch (err) {
      console.error('Failed to retry processing:', err)
      message.error(t("重试失败，请稍后再试"))
    } finally {
      setStatusLoading(false)
    }
  }

  const handleCreateCollection = async (title: string, summary: string, clipIds: string[]) => {
    if (!id) return
    try {
      await addCollection(id, {
        id: `collection_${Date.now()}`,
        collection_title: title,
        collection_summary: summary,
        clip_ids: clipIds,
        collection_type: 'manual',
        created_at: new Date().toISOString()
      })
      setShowCreateCollection(false)
      message.success(t("合集创建成功"))
    } catch (err) {
      console.error('Failed to create collection:', err)
      message.error(t("创建合集失败"))
    }
  }

  const handleViewCollection = (collection: Collection) => {
    setSelectedCollection(collection)
    setShowCollectionDetail(true)
  }

  const handleRemoveClipFromCollection = async (collectionId: string, clipId: string): Promise<void> => {
    if (!id) return
    try {
      await removeClipFromCollection(id, collectionId, clipId)
      message.success(t("切片已从合集中移除"))
    } catch (err) {
      console.error('Failed to remove clip from collection:', err)
      message.error(t("移除切片失败"))
    }
  }

  const handleDeleteCollection = async (collectionId: string) => {
    if (!id) return
    try {
      await deleteCollection(id, collectionId)
      setShowCollectionDetail(false)
      setSelectedCollection(null)
      message.success(t("合集已删除"))
    } catch (err) {
      console.error('Failed to delete collection:', err)
      message.error(t("删除合集失败"))
    }
  }

  const handleReorderCollectionClips = async (collectionId: string, newClipIds: string[]): Promise<void> => {
    if (!id) return
    try {
      await reorderCollectionClips(id, collectionId, newClipIds)
      message.success(t("合集顺序已更新"))
    } catch (err) {
      console.error('Failed to reorder collection clips:', err)
      message.error(t("更新合集顺序失败"))
    }
  }

  const handleAddClipToCollection = async (collectionId: string, clipIds: string[]): Promise<void> => {
    if (!id) return
    try {
      await addClipToCollection(id, collectionId, clipIds)
      message.success(t("切片已添加到合集"))
    } catch (err) {
      console.error('Failed to add clip to collection:', err)
      message.error(t("添加切片失败"))
    }
  }

  const createDraft = async (clipIds: string[], title: string) => {
    try {
      const draft = await studioApi.create(id!, clipIds, title, true)
      navigate(`/project/${id}/studio/${draft.id}`)
    } catch (e) { message.error(errorText(e)) }
  }

  const getSortedClips = () => {
    if (!activeProject?.clips) return []
    const clips = [...activeProject.clips]
    return clips.sort((a, b) => b.final_score - a.final_score)
  }

  if (loading && !activeProject) {
    return (
      <div className="ac-page" style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <span className="ac-btn ac-btn--text" style={{ color: 'var(--ac-muted)' }}><span className="spin" />{t("加载中")}</span>
      </div>
    )
  }

  if (error || !activeProject || activeProject.id !== id) {
    if (loading) {
      return (
        <div className="ac-page" style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
          <span className="ac-btn ac-btn--text" style={{ color: 'var(--ac-muted)' }}><span className="spin" />{t("加载中")}</span>
        </div>
      )
    }
    return (
      <div className="ac-page">
        <div className="ac-empty">
          <b>{t("加载失败")}</b>
          {error || t("项目不存在")}
          <div style={{ marginTop: 16 }}>
            <Btn size="sm" onClick={() => navigate('/')}>{t("返回首页")}</Btn>
          </div>
        </div>
      </div>
    )
  }

  if (needsImportConfirmation(activeProject)) return <Navigate to={`/import/${id}`} replace />

  const clips = activeProject.clips || []
  const collections = activeProject.collections || []
  const totalClipSec = clips.reduce((s, c) => s + Math.max(0, parseTimecode(c.end_time) - parseTimecode(c.start_time)), 0)
  const sortedCollections = [...collections].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0
    return tb - ta
  })
  const isExample = !!(activeProject.settings?.example || activeProject.processing_config?.example)
  const sourceHost = (() => { try { return activeProject.source_url ? new URL(activeProject.source_url).hostname.replace(/^www\./, '') : '' } catch { return '' } })()
  const isVisual = !!activeProject.settings?.smart_import || !!activeProject.processing_config?.smart_import || ['highlight', 'promo'].includes(activeProject.settings?.creative?.goal || activeProject.processing_config?.creative?.goal)
  const isCompleted = activeProject.status === 'completed'
  const isFailed = activeProject.status === 'failed' || (activeProject.status as string) === 'error'
  const llmKeyFailure = !timelineEmpty && classifyLlmKeyFailure(activeProject.error_message, activeProject.error_code)
  const failureContext = {
    source: 'failure' as const,
    project_id: activeProject.id,
    error_message: activeProject.error_message || undefined,
    error_code: activeProject.error_code || undefined,
  }

  return (
    <div className="ac-page">
      {/* 页头：返回 · 标题 · mono 元信息 */}
      <header>
        <button className="ac-back" onClick={() => navigate('/')}>
          <Icon.Back />{t("项目")}</button>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ minWidth: 0 }}>
            <h1 className="ac-title">{activeProject.name}</h1>
            <div className="ac-meta">
              {isVisual ? <span>{t('智能制作')}</span> : isCompleted ? (
                <>
                  <span>{t("切片数量", { count: clips.length })}</span>
                  <span className="dot" />
                  <span>{t("合集数量", { count: collections.length })}</span>
                  {totalClipSec > 0 && (
                    <>
                      <span className="dot" />
                      <span>{t("共")} <span className="ac-mono">{fmtDuration(totalClipSec)}</span></span>
                    </>
                  )}
                </>
              ) : (
                <span>{activeProject.status === 'pending' ? t("等待处理") : isFailed ? t("处理失败") : t("处理中")}</span>
              )}
              {activeProject.created_at && (
                <>
                  <span className="dot" />
                  <span>{dayjs(activeProject.created_at).fromNow()}</span>
                </>
              )}
              {sourceHost && (
                <>
                  <span className="dot" />
                  <a className="ac-link" href={activeProject.source_url} onClick={e => { e.preventDefault(); openExternalLink(activeProject.source_url!) }}>
                    {t("来源")} {sourceHost} ↗
                  </a>
                </>
              )}
              {isExample && (
                <>
                  <span className="dot" />
                  <span>{t("示例项目 · 原片只保留了三段")}</span>
                </>
              )}
            </div>
          </div>
          {isCompleted && clips.length > 0 && (
            <Btn onClick={() => navigate(`/project/${activeProject.id}/publish`)}>{t("发布")}</Btn>
          )}
          {!isVisual && activeProject.status === 'pending' && (
            <Btn variant="cta" onClick={handleStartProcessing} loading={statusLoading}>{t("开始处理")}</Btn>
          )}
          {!isVisual && isFailed && (
            <div style={{ display: 'flex', gap: 8, flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Btn onClick={() => setFeedbackOpen(true)}>{t("反馈问题")}</Btn>
              <Btn variant={llmKeyFailure || shownSubtitleKind ? undefined : 'cta'} onClick={handleRetryProcessing} loading={statusLoading}>{t("重试")}</Btn>
            </div>
          )}
        </div>
      </header>

      {isCompleted || isVisual ? (
        <StudioResults key={activeProject.id} project={activeProject} onCreateCollection={() => setShowCreateCollection(true)} onReload={loadProject}>
          {sortedCollections.map(collection => <CollectionCard key={collection.id} collection={collection} clips={clips}
            onView={handleViewCollection}
            onEdit={() => createDraft(collection.clip_ids, collection.collection_title)}
            onUpdate={(collectionId, updates) => updateCollection(activeProject.id, collectionId, updates)}
            onGenerateVideo={async collectionId => { const c = collections.find(x => x.id === collectionId); if(c) await generateAndDownloadCollectionVideo(activeProject.id, collectionId, c.collection_title) }}
            onDelete={handleDeleteCollection} />)}
          {getSortedClips().map(clip => <ClipCard key={clip.id} clip={clip} projectId={activeProject.id}
            onEdit={() => createDraft([clip.id], clip.generated_title || clip.title || t('新成片'))}
            videoUrl={projectApi.getClipVideoUrl(activeProject.id, clip.id, clip.title || clip.generated_title)}
            onDownload={clipId => projectApi.downloadVideo(activeProject.id, clipId)}
            onClipUpdate={(clipId, updates) => setCurrentProject({...activeProject, clips: clips.map(c => c.id === clipId ? {...c, ...updates} : c)})} />)}
        </StudioResults>
      ) : isFailed && shownSubtitleKind ? (
        <SubtitleFailureEmpty
          kind={shownSubtitleKind}
          errorMessage={activeProject.error_message}
          onOpenSettings={() => navigate('/settings?section=speech')}
        />
      ) : isFailed && llmKeyFailure ? (
        <LlmKeyFailureEmpty
          errorMessage={activeProject.error_message}
          onOpenSettings={() => navigate('/settings?section=model')}
        />
      ) : isFailed ? (
        <div className="ac-empty" style={{ marginTop: 32 }}>
          <b>{t("这次处理没有成功")}</b>
          {activeProject.error_message ? (
            <span className="ac-mono" style={{ display: 'block', marginTop: 6, color: 'var(--ac-muted)', wordBreak: 'break-word' }}>
              {activeProject.error_message}
            </span>
          ) : (
            t("可以直接重试；如果反复失败，点「反馈问题」，运行环境与错误会自动附上。")
          )}
        </div>
      ) : (
        <div style={{ marginTop: 32 }}>
          <ProjectTaskManager projectId={activeProject.id} projectName={activeProject.name} />
          <div className="ac-empty" style={{ marginTop: 24 }}>
            <b>{t("还在处理中")}</b>{t("完成后这里会出现切片与合集。")}</div>
        </div>
      )}

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} context={failureContext} />

      <CreateCollectionModal
        visible={showCreateCollection}
        clips={clips}
        onCancel={() => setShowCreateCollection(false)}
        onCreate={handleCreateCollection}
      />

      <CollectionPreviewModal
        visible={showCollectionDetail}
        collection={selectedCollection}
        clips={clips}
        projectId={activeProject.id}
        onClose={() => {
          setShowCollectionDetail(false)
          setSelectedCollection(null)
        }}
        onUpdateCollection={(collectionId, updates) => updateCollection(activeProject.id, collectionId, updates)}
        onRemoveClip={handleRemoveClipFromCollection}
        onReorderClips={handleReorderCollectionClips}
        onDelete={handleDeleteCollection}
        onAddClip={handleAddClipToCollection}
      />
    </div>
  )
}

export default ProjectDetailPage
