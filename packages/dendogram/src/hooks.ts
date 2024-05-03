import { createElement, MouseEvent, useCallback, useMemo, useState } from 'react'
import { hierarchy as d3Hierarchy, cluster as d3Cluster } from 'd3-hierarchy'
import { scaleLinear, ScaleLinear } from 'd3-scale'
import { usePropertyAccessor, useTheme } from '@nivo/core'
import { useTooltip } from '@nivo/tooltip'
import { useOrdinalColorScale, useInheritedColor } from '@nivo/colors'
import {
    DefaultDatum,
    HierarchyDendogramNode,
    HierarchyDendogramLink,
    DendogramDataProps,
    CommonProps,
    Layout,
    ComputedNode,
    ComputedLink,
    NodeMouseEventHandler,
    NodeTooltip,
    IntermediateComputedLink,
    LinkThicknessFunction,
    LinkMouseEventHandler,
    LinkTooltip,
    IntermediateComputedNode,
    CurrentNodeSetter,
    NodeSizeModifierFunction,
} from './types'
import { commonDefaultProps } from './defaults'

export const useRoot = <Datum extends object>({
    data,
    getIdentity,
}: {
    data: DendogramDataProps<Datum>['data']
    getIdentity: (node: Datum) => string
}) =>
    useMemo(() => {
        const root = d3Hierarchy<Datum>(data) as HierarchyDendogramNode<Datum>
        const cluster = d3Cluster<Datum>().size([1, 1])

        root.eachBefore(node => {
            const ancestors = node
                .ancestors()
                .filter(ancestor => ancestor !== node)
                .reverse()
            const ancestorIds = ancestors.map(ancestor => getIdentity(ancestor.data))

            node.ancestorIds = ancestorIds
            node.uid = [...ancestorIds, getIdentity(node.data)].join('.')
            node.ancestorUids = ancestors.map(ancestor => ancestor.uid!)
        })

        root.each(node => {
            node.descendantUids = node
                .descendants()
                .filter(descendant => descendant !== node)
                .map(descendant => descendant.uid!)
        })

        cluster(root)

        return root
    }, [data, getIdentity])

/**
 * By default, the x/y positions are computed for a 0~1 range,
 * so that we can easily change the layout without having to
 * recompute the nodes.
 */
const useCartesianScales = ({
    width,
    height,
    layout,
}: {
    width: number
    height: number
    layout: Layout
}) =>
    useMemo(() => {
        const xScale = scaleLinear().domain([0, 1])
        const yScale = scaleLinear().domain([0, 1])

        if (layout === 'top-to-bottom') {
            xScale.range([0, width])
            yScale.range([0, height])
        } else if (layout === 'right-to-left') {
            xScale.range([width, 0])
            yScale.range([0, height])
        } else if (layout === 'bottom-to-top') {
            xScale.range([width, 0])
            yScale.range([height, 0])
        } else if (layout === 'left-to-right') {
            xScale.range([0, width])
            yScale.range([height, 0])
        }

        return {
            xScale,
            yScale,
        }
    }, [width, height, layout])

const useNodeSize = <Datum extends object>(
    size: Exclude<CommonProps<Datum>['nodeSize'], undefined>
) =>
    useMemo(() => {
        if (typeof size === 'function') return size
        return () => size
    }, [size])

const useNodeSizeModifier = <Datum extends object>(
    size?: NodeSizeModifierFunction<Datum> | number
) =>
    useMemo(() => {
        if (size === undefined) return (node: ComputedNode<Datum>) => node.size
        if (typeof size === 'function') return size
        return () => size
    }, [size])

const useNodes = <Datum extends object>({
    root,
    xScale,
    yScale,
    layout,
    getIdentity,
    nodeSize,
    activeNodeSize,
    inactiveNodeSize,
    nodeColor,
}: {
    root: HierarchyDendogramNode<Datum>
    xScale: ScaleLinear<number, number>
    yScale: ScaleLinear<number, number>
    layout: Layout
    getIdentity: (node: Datum) => string
    nodeSize: Exclude<CommonProps<Datum>['nodeSize'], undefined>
    activeNodeSize?: CommonProps<Datum>['activeNodeSize']
    inactiveNodeSize?: CommonProps<Datum>['inactiveNodeSize']
    nodeColor: Exclude<CommonProps<Datum>['nodeColor'], undefined>
}) => {
    const intermediateNodes = useMemo<IntermediateComputedNode<Datum>[]>(() => {
        return root.descendants().map(node => {
            let x: number
            let y: number
            if (layout === 'top-to-bottom' || layout === 'bottom-to-top') {
                x = xScale(node.x!)
                y = yScale(node.y!)
            } else {
                x = xScale(node.y!)
                y = yScale(node.x!)
            }

            const id = getIdentity(node.data)

            return {
                path: [...node.ancestorIds!, id],
                uid: node.uid!,
                ancestorIds: node.ancestorIds!,
                ancestorUids: node.ancestorUids!,
                descendantUids: node.descendantUids!,
                id,
                data: node.data,
                depth: node.depth,
                height: node.height,
                x,
                y,
            }
        })
    }, [root, getIdentity, layout, xScale, yScale])

    const getNodeSize = useNodeSize<Datum>(nodeSize)
    const getActiveNodeSize = useNodeSizeModifier<Datum>(activeNodeSize)
    const getInactiveNodeSize = useNodeSizeModifier<Datum>(inactiveNodeSize)
    const getNodeColor = useOrdinalColorScale(nodeColor, 'uid')

    const [activeNodeUids, setActiveNodeUids] = useState<string[]>([])

    const computed = useMemo(() => {
        const nodeByUid: Record<string, ComputedNode<Datum>> = {}

        const nodes: ComputedNode<Datum>[] = intermediateNodes.map(intermediateNode => {
            const computedNode: ComputedNode<Datum> = {
                ...intermediateNode,
                size: getNodeSize(intermediateNode),
                color: getNodeColor(intermediateNode),
                isActive: null,
            }

            if (activeNodeUids.length > 0) {
                computedNode.isActive = activeNodeUids.includes(computedNode.uid)
                if (computedNode.isActive) {
                    computedNode.size = getActiveNodeSize(computedNode)
                } else {
                    computedNode.size = getInactiveNodeSize(computedNode)
                }
            }

            nodeByUid[computedNode.uid] = computedNode

            return computedNode
        })

        return { nodes, nodeByUid }
    }, [
        intermediateNodes,
        getNodeSize,
        getActiveNodeSize,
        getInactiveNodeSize,
        getNodeColor,
        activeNodeUids,
    ])

    return { ...computed, setActiveNodeUids }
}

const useLinks = <Datum extends object>({
    root,
    nodeByUid,
    linkThickness,
    linkColor,
}: {
    root: HierarchyDendogramNode<Datum>
    nodeByUid: Record<string, ComputedNode<Datum>>
    linkThickness: Exclude<CommonProps<Datum>['linkThickness'], undefined>
    linkColor: Exclude<CommonProps<Datum>['linkColor'], undefined>
}) => {
    const intermediateLinks = useMemo<IntermediateComputedLink<Datum>[]>(() => {
        return (root.links() as HierarchyDendogramLink<Datum>[]).map(link => {
            return {
                id: `${link.source.uid}:${link.target.uid}`,
                // Replace with computed nodes.
                source: nodeByUid[link.source.uid!],
                target: nodeByUid[link.target.uid!],
            }
        })
    }, [root, nodeByUid])

    const getLinkThickness: LinkThicknessFunction<Datum> = useMemo(() => {
        if (typeof linkThickness === 'function') return linkThickness
        return () => linkThickness
    }, [linkThickness])

    const theme = useTheme()
    const getLinkColor = useInheritedColor(linkColor, theme)

    const [activeLinkIds, setActiveLinkIds] = useState<string[]>([])

    const links = useMemo(() => {
        return intermediateLinks.map(intermediateLink => {
            const computedLink: ComputedLink<Datum> = {
                ...intermediateLink,
                thickness: getLinkThickness(intermediateLink),
                color: getLinkColor(intermediateLink),
                isActive: null,
            }

            if (activeLinkIds.length > 0) {
                computedLink.isActive = activeLinkIds.includes(computedLink.id)
                if (computedLink.isActive) {
                    computedLink.thickness = 10
                } else {
                    computedLink.thickness = 1
                }
            }

            return computedLink
        })
    }, [intermediateLinks, getLinkThickness, getLinkColor, activeLinkIds])

    return {
        links,
        setActiveLinkIds,
    }
}

export const useDendogram = <Datum extends object = DefaultDatum>({
    data,
    width,
    height,
    identity = commonDefaultProps.identity,
    layout = commonDefaultProps.layout,
    nodeSize = commonDefaultProps.nodeSize,
    activeNodeSize,
    inactiveNodeSize,
    nodeColor = commonDefaultProps.nodeColor,
    highlightAncestorNodes = commonDefaultProps.highlightAncestorNodes,
    highlightDescendantNodes = commonDefaultProps.highlightDescendantNodes,
    linkThickness = commonDefaultProps.linkThickness,
    linkColor = commonDefaultProps.linkColor,
    highlightAncestorLinks = commonDefaultProps.highlightAncestorLinks,
    highlightDescendantLinks = commonDefaultProps.highlightDescendantLinks,
}: {
    data: DendogramDataProps<Datum>['data']
    width: number
    height: number
    identity?: CommonProps<Datum>['identity']
    layout?: Layout
    nodeSize?: CommonProps<Datum>['nodeSize']
    activeNodeSize?: CommonProps<Datum>['activeNodeSize']
    inactiveNodeSize?: CommonProps<Datum>['inactiveNodeSize']
    nodeColor?: CommonProps<Datum>['nodeColor']
    highlightAncestorNodes?: boolean
    highlightDescendantNodes?: boolean
    linkThickness?: CommonProps<Datum>['linkThickness']
    linkColor?: CommonProps<Datum>['linkColor']
    highlightAncestorLinks?: boolean
    highlightDescendantLinks?: boolean
}) => {
    const getIdentity = usePropertyAccessor(identity)
    const root = useRoot<Datum>({ data, getIdentity })

    const { xScale, yScale } = useCartesianScales({ width, height, layout })
    const { nodes, nodeByUid, setActiveNodeUids } = useNodes<Datum>({
        root,
        xScale,
        yScale,
        layout,
        getIdentity,
        nodeSize,
        activeNodeSize,
        inactiveNodeSize,
        nodeColor,
    })

    const { links, setActiveLinkIds } = useLinks<Datum>({
        root,
        nodeByUid,
        linkThickness,
        linkColor,
    })

    const setCurrentNode = useCallback(
        (node: ComputedNode<Datum> | null) => {
            if (node === null) {
                setActiveNodeUids([])
                setActiveLinkIds([])
            } else {
                let nodeUids: string[] = [node.uid]
                if (highlightAncestorNodes) {
                    nodeUids = [...nodeUids, ...node.ancestorUids]
                }
                if (highlightDescendantNodes) {
                    nodeUids = [...nodeUids, ...node.descendantUids]
                }
                setActiveNodeUids(nodeUids)

                const linkIds: string[] = []
                if (highlightAncestorLinks) {
                    links
                        .filter(link => {
                            return (
                                link.target.uid === node.uid ||
                                node.ancestorUids.includes(link.target.uid)
                            )
                        })
                        .forEach(link => {
                            linkIds.push(link.id)
                        })
                }
                if (highlightDescendantLinks) {
                    links
                        .filter(link => {
                            return (
                                link.source.uid === node.uid ||
                                node.descendantUids.includes(link.source.uid)
                            )
                        })
                        .forEach(link => {
                            linkIds.push(link.id)
                        })
                }
                setActiveLinkIds(linkIds)
            }
        },
        [
            setActiveNodeUids,
            highlightAncestorNodes,
            highlightDescendantNodes,
            links,
            setActiveLinkIds,
            highlightAncestorLinks,
            highlightDescendantLinks,
        ]
    )

    return {
        nodes,
        links,
        setCurrentNode,
    }
}

/**
 * This hook may generates mouse event handlers for a node according to the main chart props.
 * It's used for the default `Node` component and may be used for custom nodes
 * to simplify their implementation.
 */
export const useNodeMouseEventHandlers = <Datum extends object>(
    node: ComputedNode<Datum>,
    {
        isInteractive,
        onMouseEnter,
        onMouseMove,
        onMouseLeave,
        onClick,
        setCurrentNode,
        tooltip,
    }: {
        isInteractive: boolean
        onMouseEnter?: NodeMouseEventHandler<Datum>
        onMouseMove?: NodeMouseEventHandler<Datum>
        onMouseLeave?: NodeMouseEventHandler<Datum>
        onClick?: NodeMouseEventHandler<Datum>
        setCurrentNode: CurrentNodeSetter<Datum>
        tooltip?: NodeTooltip<Datum>
    }
) => {
    const { showTooltipFromEvent, hideTooltip } = useTooltip()

    const showTooltip = useCallback(
        (event: MouseEvent) => {
            tooltip !== undefined &&
                showTooltipFromEvent(
                    createElement(tooltip, {
                        node,
                    }),
                    event
                )
        },
        [node, tooltip, showTooltipFromEvent]
    )

    const handleMouseEnter = useCallback(
        (event: MouseEvent) => {
            setCurrentNode(node)
            showTooltip(event)
            onMouseEnter?.(node, event)
        },
        [node, showTooltip, setCurrentNode, onMouseEnter]
    )

    const handleMouseMove = useCallback(
        (event: MouseEvent) => {
            showTooltip(event)
            onMouseMove?.(node, event)
        },
        [node, showTooltip, onMouseMove]
    )

    const handleMouseLeave = useCallback(
        (event: MouseEvent) => {
            setCurrentNode(null)
            hideTooltip()
            onMouseLeave?.(node, event)
        },
        [node, hideTooltip, setCurrentNode, onMouseLeave]
    )

    const handleClick = useCallback(
        (event: MouseEvent) => {
            onClick?.(node, event)
        },
        [node, onClick]
    )

    return {
        onMouseEnter: isInteractive ? handleMouseEnter : undefined,
        onMouseMove: isInteractive ? handleMouseMove : undefined,
        onMouseLeave: isInteractive ? handleMouseLeave : undefined,
        onClick: isInteractive ? handleClick : undefined,
    }
}

/**
 * This hook may generates mouse event handlers for a node according to the main chart props.
 * It's used for the default `Node` component and may be used for custom nodes
 * to simplify their implementation.
 */
export const useLinkMouseEventHandlers = <Datum extends object>(
    link: ComputedLink<Datum>,
    {
        isInteractive,
        onMouseEnter,
        onMouseMove,
        onMouseLeave,
        onClick,
        tooltip,
    }: {
        isInteractive: boolean
        onMouseEnter?: LinkMouseEventHandler<Datum>
        onMouseMove?: LinkMouseEventHandler<Datum>
        onMouseLeave?: LinkMouseEventHandler<Datum>
        onClick?: LinkMouseEventHandler<Datum>
        tooltip?: LinkTooltip<Datum>
    }
) => {
    const { showTooltipFromEvent, hideTooltip } = useTooltip()

    const showTooltip = useCallback(
        (event: MouseEvent) => {
            tooltip !== undefined &&
                showTooltipFromEvent(
                    createElement(tooltip, {
                        link,
                    }),
                    event
                )
        },
        [link, tooltip, showTooltipFromEvent]
    )

    const handleMouseEnter = useCallback(
        (event: MouseEvent) => {
            showTooltip(event)
            onMouseEnter?.(link, event)
        },
        [link, showTooltip, onMouseEnter]
    )

    const handleMouseMove = useCallback(
        (event: MouseEvent) => {
            showTooltip(event)
            onMouseMove?.(link, event)
        },
        [link, showTooltip, onMouseMove]
    )

    const handleMouseLeave = useCallback(
        (event: MouseEvent) => {
            hideTooltip()
            onMouseLeave?.(link, event)
        },
        [link, hideTooltip, onMouseLeave]
    )

    const handleClick = useCallback(
        (event: MouseEvent) => {
            onClick?.(link, event)
        },
        [link, onClick]
    )

    return {
        onMouseEnter: isInteractive ? handleMouseEnter : undefined,
        onMouseMove: isInteractive ? handleMouseMove : undefined,
        onMouseLeave: isInteractive ? handleMouseLeave : undefined,
        onClick: isInteractive ? handleClick : undefined,
    }
}