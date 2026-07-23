import type { ComponentProps } from 'react'
import ControlCenter from './ControlCenter'
import WorkflowLedgerPanel from './WorkflowLedgerPanel'

export default function ControlCenterWithWorkflow(props: ComponentProps<typeof ControlCenter>): React.JSX.Element {
  return (
    <>
      <ControlCenter {...props} />
      <WorkflowLedgerPanel />
    </>
  )
}
